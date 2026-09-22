import path from "node:path";
import { performance } from "node:perf_hooks";
import { Command, InvalidArgumentError } from "commander";
import { normalizeOutputError } from "../acp/error-normalization.js";
import { TimeoutError } from "../async-control.js";
import { DISCARD_OUTPUT_FORMATTER } from "../session/execution/discard-output.js";
import { runOnce } from "../session/session.js";
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionStats,
  PromptInput,
  SessionNotification,
  SessionTokenUsage,
} from "../types.js";
import { EXIT_CODES } from "../types.js";
import { addCompareOptions, scanCompareArgs } from "./compare-args.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
} from "./flags.js";
import {
  sessionOptionsFromGlobalFlags,
  sessionConnectionOptions,
  resolvePermissionPolicyFromFlags,
} from "./invocation-options.js";
import { readPromptInput } from "./prompt-input.js";

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
  _meta?: Record<string, unknown> | null;
};

type CompareFlags = {
  cwd?: string;
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
  timeout?: number;
  format?: string;
  file?: string;
  promptFile?: string;
};

type RunCapture = {
  finalMessage: string;
  usage: SessionTokenUsage;
  permissionStats: PermissionStats;
};

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

function splitCompareArgs(
  args: string[],
  filePath: string | undefined,
  promptTokens: string[] | undefined,
): {
  agents: string[];
  promptText: string;
} {
  if (promptTokens !== undefined) {
    const agents = args.slice(0, args.length - promptTokens.length);
    if (agents.length === 0) {
      throw new InvalidArgumentError("At least one agent is required");
    }
    return { agents, promptText: promptTokens.join(" ") };
  }
  if (filePath) {
    if (args.length === 0) {
      throw new InvalidArgumentError("At least one agent is required");
    }
    return { agents: args, promptText: "" };
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
    total_tokens: numberField(source, ["total_tokens", "totalTokens"]) ?? undefined,
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
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  };
}

function rowStatusFromError(error: unknown): CompareRow["status"] {
  if (error instanceof TimeoutError) {
    return "cancelled";
  }
  const { code } = normalizeOutputError(error);
  return code === "PERMISSION_PROMPT_UNAVAILABLE" || code === "PERMISSION_DENIED"
    ? "permission_denied"
    : "error";
}

function buildErrorRow(
  agentName: string,
  caught: unknown,
  capture: RunCapture,
  startedAt: number,
): CompareRow {
  return {
    agent: agentName,
    status: rowStatusFromError(caught),
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
    permission_requests: capture.permissionStats.requested,
    permission_denied: capture.permissionStats.denied + capture.permissionStats.cancelled,
  };
}

async function runAgentForCompare(params: {
  agentName: string;
  prompt: PromptInput;
  config: ResolvedAcpxConfig;
  globalFlags: ReturnType<typeof resolveGlobalFlags>;
  permissionMode: PermissionMode;
  permissionPolicy: PermissionPolicy | undefined;
}): Promise<CompareRow> {
  const capture: RunCapture = {
    finalMessage: "",
    usage: {},
    permissionStats: { requested: 0, approved: 0, denied: 0, cancelled: 0 },
  };
  const t0 = performance.now();

  try {
    const agent = resolveAgentInvocation(params.agentName, params.globalFlags, params.config);
    const result = await runOnce({
      ...sessionConnectionOptions(params.globalFlags, params.config),
      agentCommand: agent.agentCommand,
      agentArgv: agent.agentArgv,
      cwd: agent.cwd,
      prompt: params.prompt,
      permissionMode: params.permissionMode,
      permissionPolicy: params.permissionPolicy,
      outputFormatter: DISCARD_OUTPUT_FORMATTER,
      suppressSdkConsoleErrors: true,
      timeoutMs: params.globalFlags.timeout ?? DEFAULT_COMPARE_TIMEOUT_MS,
      promptRetries: params.globalFlags.promptRetries,
      sessionOptions: sessionOptionsFromGlobalFlags(params.globalFlags),
      onSessionUpdate: (notification) => captureSessionUpdate(notification, capture),
      onPermissionStats: (stats) => {
        capture.permissionStats = stats;
      },
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

async function runCompareAgents(
  agents: string[],
  run: (agentName: string) => Promise<CompareRow>,
): Promise<{ rows: CompareRow[]; interrupted: boolean }> {
  const rows: CompareRow[] = [];
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) {
    process.once(signal, onInterrupt);
  }
  try {
    for (const agentName of agents) {
      if (interrupted) {
        break;
      }
      // runOnce owns active cancellation and cleanup; this loop owns the next admission.
      const row = await run(agentName);
      rows.push(interrupted ? { ...row, status: "cancelled", error: "Interrupted" } : row);
    }
  } finally {
    for (const signal of signals) {
      process.off(signal, onInterrupt);
    }
  }
  return { rows, interrupted };
}

function resolvePromptFile(flags: CompareFlags): string | undefined {
  if (flags.file && flags.promptFile && flags.file !== flags.promptFile) {
    throw new InvalidArgumentError("Use only one prompt file flag: --file or --prompt-file");
  }
  return flags.file ?? flags.promptFile;
}

export function registerCompareCommand(program: Command, config: ResolvedAcpxConfig): void {
  addCompareOptions(
    program
      .command("compare")
      .description("Run one prompt across multiple agents and summarize the results")
      .argument("<args...>", "Agents followed by prompt text, or agents with --file"),
  ).action(async function (this: Command, args: string[], flags: CompareFlags) {
    if (config.disableExec) {
      throw new Error("compare subcommand is disabled by configuration (disableExec: true)");
    }

    const globalFlags = resolveGlobalFlags(this, config);
    if (flags.cwd !== undefined) {
      globalFlags.cwd = path.resolve(flags.cwd);
    }
    if (globalFlags.agent) {
      throw new InvalidArgumentError("Do not combine compare with --agent; pass agent names");
    }

    const outputPolicy = resolveOutputPolicy(globalFlags.format, globalFlags.jsonStrict === true);
    const promptFile = resolvePromptFile(flags);
    const { promptTokens } = scanCompareArgs(program.args.slice(1));
    const { agents, promptText } = splitCompareArgs(args, promptFile, promptTokens);
    const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
    const prompt = await readPromptInput(promptFile, promptText, globalFlags.cwd, "final argument");
    const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);

    const { rows, interrupted } = await runCompareAgents(
      agents,
      async (agentName) =>
        await runAgentForCompare({
          agentName,
          prompt,
          config,
          globalFlags,
          permissionMode,
          permissionPolicy,
        }),
    );

    printRows(rows, outputPolicy.format);
    if (interrupted) {
      process.exitCode = EXIT_CODES.INTERRUPTED;
    } else {
      updateCompareExitCode(rows);
    }
  });
}
