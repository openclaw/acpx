import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Command, InvalidArgumentError } from "commander";
import { TimeoutError } from "../async-control.js";
import { loadPermissionPolicySpec } from "../permission-policy.js";
import {
  mergePromptSourceWithText,
  parsePromptSource,
  PromptInputValidationError,
  textPrompt,
} from "../prompt-content.js";
import { runOnce } from "../session/session.js";
import type {
  AcpJsonRpcMessage,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  OutputFormatterContext,
  PermissionEscalationEvent,
  PermissionPolicy,
  PermissionStats,
  PromptInput,
  SessionNotification,
  SessionTokenUsage,
} from "../types.js";
import { EXIT_CODES } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  parseNonEmptyValue,
  parseOutputFormat,
  parseTimeoutSeconds,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
} from "./flags.js";

const DEFAULT_COMPARE_TIMEOUT_MS = 300_000;
const FINAL_MESSAGE_PREVIEW_CHARS = 200;

export type CompareRow = {
  agent: string;
  status: "ok" | "cancelled" | "error" | "permission_denied";
  stop_reason: string | null;
  wall_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  final_message: string;
  error: string | null;
  permission_requests: number;
  permission_denied: number;
};

type CompareFlags = {
  cwd?: string;
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
  timeout?: number;
  format?: string;
  json?: boolean;
  file?: string;
  promptFile?: string;
};

type RunCapture = {
  finalMessage: string;
  usage: SessionTokenUsage;
  errors: string[];
};

class CaptureFormatter implements OutputFormatter {
  setContext(_context: OutputFormatterContext): void {
    // Compare renders one summarized row per agent instead of streaming each turn.
  }

  onAcpMessage(_message: AcpJsonRpcMessage): void {
    // The live update callback below owns summary extraction.
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    void params;
  }

  onPermissionEscalation(_event: PermissionEscalationEvent): void {
    // Permission counts come from RunPromptResult.permissionStats.
  }

  flush(): void {
    // no-op
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(source: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function readPromptFile(
  filePath: string,
  promptText: string,
  cwd: string,
): Promise<PromptInput> {
  const source =
    filePath === "-" ? await readStdin() : await fs.readFile(path.resolve(cwd, filePath), "utf8");
  const prompt = mergePromptSourceWithText(source, promptText);
  if (prompt.length === 0) {
    throw new InvalidArgumentError("Prompt from --file is empty");
  }
  return prompt;
}

async function readPromptFromStdin(): Promise<PromptInput> {
  if (process.stdin.isTTY) {
    throw new InvalidArgumentError(
      "Prompt is required (pass as final argument, --file, or pipe via stdin)",
    );
  }

  const prompt = parsePromptSource(await readStdin());
  if (prompt.length === 0) {
    throw new InvalidArgumentError("Prompt from stdin is empty");
  }
  return prompt;
}

async function readPromptInput(
  filePath: string | undefined,
  promptText: string,
  cwd: string,
): Promise<PromptInput> {
  try {
    if (filePath) {
      return await readPromptFile(filePath, promptText, cwd);
    }

    const joined = promptText.trim();
    if (joined.length > 0) {
      return textPrompt(joined);
    }

    return await readPromptFromStdin();
  } catch (error) {
    if (error instanceof PromptInputValidationError) {
      throw new InvalidArgumentError(error.message);
    }
    throw error;
  }
}

function promptTokensAfterDoubleDash(command: Command): string[] {
  const commandName = command.name();
  const commandIndex = process.argv.findIndex(
    (token, index) => index >= 2 && token === commandName,
  );
  if (commandIndex < 0) {
    return [];
  }
  const delimiterIndex = process.argv.findIndex(
    (token, index) => index > commandIndex && token === "--",
  );
  return delimiterIndex < 0 ? [] : process.argv.slice(delimiterIndex + 1);
}

function splitCompareArgs(
  args: string[],
  filePath: string | undefined,
  command: Command,
): {
  agents: string[];
  promptText: string;
} {
  if (filePath) {
    if (args.length === 0) {
      throw new InvalidArgumentError("At least one agent is required");
    }
    return { agents: args, promptText: "" };
  }

  const promptTokens = promptTokensAfterDoubleDash(command);
  if (promptTokens.length > 0) {
    const agents = args.slice(0, -promptTokens.length);
    if (agents.length === 0) {
      throw new InvalidArgumentError("At least one agent is required");
    }
    return { agents, promptText: promptTokens.join(" ") };
  }

  if (args.length < 2) {
    throw new InvalidArgumentError("Usage: acpx compare <agent>... '<prompt>'");
  }

  return {
    agents: args.slice(0, -1),
    promptText: args[args.length - 1] ?? "",
  };
}

function captureUsage(update: Record<string, unknown>, capture: RunCapture): void {
  const usageMeta = asRecord(asRecord(update._meta)?.usage);
  const source = usageMeta ?? update;
  capture.usage = {
    input_tokens: numberField(source, ["input_tokens", "inputTokens"]) ?? undefined,
    output_tokens: numberField(source, ["output_tokens", "outputTokens"]) ?? undefined,
    total_tokens: numberField(source, ["total_tokens", "totalTokens", "size", "used"]) ?? undefined,
  };
}

function captureSessionUpdate(notification: SessionNotification, capture: RunCapture): void {
  const update = asRecord(notification.update);
  if (!update) {
    return;
  }

  if (update.sessionUpdate === "agent_message_chunk") {
    const content = asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      capture.finalMessage += content.text;
    }
    return;
  }

  if (update.sessionUpdate === "usage_update") {
    captureUsage(update, capture);
  }
}

function rowStatusFromPermissionStats(stats: PermissionStats): CompareRow["status"] {
  const deniedOrCancelled = stats.denied + stats.cancelled;
  return deniedOrCancelled > 0 ? "permission_denied" : "ok";
}

function sessionOptionsFromGlobalFlags(globalFlags: ReturnType<typeof resolveGlobalFlags>) {
  return {
    model: globalFlags.model,
    allowedTools: globalFlags.allowedTools,
    maxTurns: globalFlags.maxTurns,
    systemPrompt: globalFlags.systemPrompt,
  };
}

async function resolvePermissionPolicyFromFlags(
  globalFlags: ReturnType<typeof resolveGlobalFlags>,
): Promise<PermissionPolicy | undefined> {
  try {
    return await loadPermissionPolicySpec(globalFlags.permissionPolicy, globalFlags.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(`Invalid permission policy: ${message}`);
  }
}

function buildSuccessRow(
  agentName: string,
  result: Awaited<ReturnType<typeof runOnce>>,
  capture: RunCapture,
  startedAt: number,
): CompareRow {
  const permissionStats = result.permissionStats;
  return {
    agent: agentName,
    status:
      result.stopReason === "cancelled"
        ? "cancelled"
        : rowStatusFromPermissionStats(permissionStats),
    stop_reason: result.stopReason,
    wall_ms: Math.round(performance.now() - startedAt),
    input_tokens: capture.usage.input_tokens ?? null,
    output_tokens: capture.usage.output_tokens ?? null,
    total_tokens: capture.usage.total_tokens ?? null,
    final_message: truncate(collapseWhitespace(capture.finalMessage), FINAL_MESSAGE_PREVIEW_CHARS),
    error: null,
    permission_requests: permissionStats.requested,
    permission_denied: permissionStats.denied + permissionStats.cancelled,
  };
}

function buildErrorRow(
  agentName: string,
  caught: unknown,
  capture: RunCapture,
  startedAt: number,
): CompareRow {
  return {
    agent: agentName,
    status: caught instanceof TimeoutError ? "cancelled" : "error",
    stop_reason: null,
    wall_ms: Math.round(performance.now() - startedAt),
    input_tokens: capture.usage.input_tokens ?? null,
    output_tokens: capture.usage.output_tokens ?? null,
    total_tokens: capture.usage.total_tokens ?? null,
    final_message: truncate(collapseWhitespace(capture.finalMessage), FINAL_MESSAGE_PREVIEW_CHARS),
    error: truncate(
      collapseWhitespace(caught instanceof Error ? caught.message : String(caught)),
      FINAL_MESSAGE_PREVIEW_CHARS,
    ),
    permission_requests: 0,
    permission_denied: 0,
  };
}

async function runAgentForCompare(params: {
  agentName: string;
  prompt: PromptInput;
  config: ResolvedAcpxConfig;
  globalFlags: ReturnType<typeof resolveGlobalFlags>;
  permissionPolicy: PermissionPolicy | undefined;
}): Promise<CompareRow> {
  const capture: RunCapture = { finalMessage: "", usage: {}, errors: [] };
  const formatter = new CaptureFormatter();
  const t0 = performance.now();

  try {
    const agent = resolveAgentInvocation(params.agentName, params.globalFlags, params.config);
    const result = await runOnce({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      prompt: params.prompt,
      mcpServers: params.config.mcpServers,
      permissionMode: resolvePermissionMode(params.globalFlags, params.config.defaultPermissions),
      nonInteractivePermissions: params.globalFlags.nonInteractivePermissions,
      permissionPolicy: params.permissionPolicy,
      authCredentials: params.config.auth,
      authPolicy: params.globalFlags.authPolicy,
      terminal: params.globalFlags.terminal,
      outputFormatter: formatter,
      suppressSdkConsoleErrors: true,
      timeoutMs: params.globalFlags.timeout ?? DEFAULT_COMPARE_TIMEOUT_MS,
      verbose: params.globalFlags.verbose,
      promptRetries: params.globalFlags.promptRetries,
      sessionOptions: sessionOptionsFromGlobalFlags(params.globalFlags),
      onSessionUpdate: (notification) => captureSessionUpdate(notification, capture),
    });
    return buildSuccessRow(params.agentName, result, capture, t0);
  } catch (caught) {
    return buildErrorRow(params.agentName, caught, capture, t0);
  }
}

function formatCell(value: unknown): string {
  if (value == null || value === "") {
    return "-";
  }
  if (typeof value === "string") {
    return collapseWhitespace(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return collapseWhitespace(JSON.stringify(value));
}

function renderTable(rows: CompareRow[]): string {
  const headers = [
    "agent",
    "status",
    "wall_ms",
    "input",
    "output",
    "total",
    "permissions",
    "stop_reason",
    "final_message",
    "error",
  ];
  const body = rows.map((row) => [
    row.agent,
    row.status,
    row.wall_ms,
    row.input_tokens,
    row.output_tokens,
    row.total_tokens,
    `${row.permission_denied}/${row.permission_requests}`,
    row.stop_reason,
    row.final_message,
    row.error,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((cells) => formatCell(cells[index]).length)),
  );
  const formatRow = (cells: unknown[]) =>
    cells
      .map((cell, index) =>
        truncate(formatCell(cell), widths[index] ?? 24).padEnd(widths[index] ?? 24),
      )
      .join("  ")
      .trimEnd();

  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(formatRow),
  ].join("\n");
}

function printRows(rows: CompareRow[], format: "text" | "json" | "quiet"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }

  if (format === "quiet") {
    for (const row of rows) {
      process.stdout.write(`${row.agent}\t${row.status}\n`);
    }
    return;
  }

  process.stdout.write(`${renderTable(rows)}\n`);
}

function updateCompareExitCode(rows: CompareRow[]): void {
  if (rows.some((row) => row.status === "error")) {
    process.exitCode = EXIT_CODES.ERROR;
    return;
  }
  if (rows.some((row) => row.status === "permission_denied")) {
    process.exitCode = EXIT_CODES.PERMISSION_DENIED;
    return;
  }
  if (rows.some((row) => row.status === "cancelled")) {
    process.exitCode = EXIT_CODES.TIMEOUT;
  }
}

function resolvePromptFile(flags: CompareFlags): string | undefined {
  if (flags.file && flags.promptFile && flags.file !== flags.promptFile) {
    throw new InvalidArgumentError("Use only one prompt file flag: --file or --prompt-file");
  }
  return flags.file ?? flags.promptFile;
}

export function registerCompareCommand(program: Command, config: ResolvedAcpxConfig): void {
  program
    .command("compare")
    .description("Run one prompt across multiple agents and summarize the results")
    .argument("<args...>", "Agents followed by prompt text, or agents with --file")
    .option("--cwd <dir>", "Target workspace")
    .option("--approve-all", "Auto-approve all permission requests")
    .option("--approve-reads", "Auto-approve read/search requests and prompt for writes")
    .option("--deny-all", "Deny all permission requests")
    .option("--timeout <seconds>", "Per-agent timeout in seconds", parseTimeoutSeconds)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--json", "Alias for --format json")
    .option(
      "-f, --file <path>",
      "Read prompt text from file path (use - for stdin)",
      (value: string) => parseNonEmptyValue("Prompt file", value),
    )
    .option("--prompt-file <path>", "Alias for --file", (value: string) =>
      parseNonEmptyValue("Prompt file", value),
    )
    .action(async function (this: Command, args: string[], flags: CompareFlags) {
      if (config.disableExec) {
        throw new Error("compare subcommand is disabled by configuration (disableExec: true)");
      }

      const globalFlags = resolveGlobalFlags(this, config);
      if (globalFlags.agent) {
        throw new InvalidArgumentError("Do not combine compare with --agent; pass agent names");
      }

      const outputPolicy = resolveOutputPolicy(
        flags.json === true ? "json" : globalFlags.format,
        globalFlags.jsonStrict === true,
      );
      const promptFile = resolvePromptFile(flags);
      const { agents, promptText } = splitCompareArgs(args, promptFile, this);
      const prompt = await readPromptInput(promptFile, promptText, globalFlags.cwd);
      const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);

      const rows: CompareRow[] = [];
      for (const agentName of agents) {
        rows.push(
          await runAgentForCompare({
            agentName,
            prompt,
            config,
            globalFlags,
            permissionPolicy,
          }),
        );
      }

      printRows(rows, outputPolicy.format);
      updateCompareExitCode(rows);
    });
}
