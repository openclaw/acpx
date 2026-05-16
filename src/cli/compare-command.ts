import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Command, InvalidArgumentError } from "commander";
import { resolveAgentCommand } from "../agent-registry.js";
import { TimeoutError } from "../async-control.js";
import { mergePromptSourceWithText, textPrompt } from "../prompt-content.js";
import { runOnce } from "../session/session.js";
import type {
  AcpJsonRpcMessage,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  OutputFormatterContext,
  PermissionEscalationEvent,
  PermissionMode,
  PromptInput,
} from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseNonEmptyValue, parseTimeoutSeconds, resolvePermissionMode } from "./flags.js";

const execFileAsync = promisify(execFile);
const DEFAULT_COMPARE_TIMEOUT_MS = 300_000;
const FINAL_MESSAGE_PREVIEW_CHARS = 200;

export type CompareRow = {
  agent: string;
  status: "ok" | "cancelled" | "error";
  stop_reason: string | null;
  wall_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  context_used: number | null;
  final_message: string;
  transcript_path: string;
  error: string | null;
  diff_stat: string | null;
  diff_path: string | null;
};

type CompareFlags = {
  cwd?: string;
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
  timeout?: number;
  json?: boolean;
  diff?: boolean;
  promptFile?: string;
};

type CompareOptions = {
  cwd: string;
  runId: string;
  permissionMode: PermissionMode;
  timeoutMs: number;
  diff: boolean;
  transcriptDir: string;
};

type TranscriptSummary = {
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  contextUsed: number | null;
  finalMessage: string;
};

type WorktreeInfo = {
  cwd: string;
  root: string;
  worktreePath: string;
};

class TranscriptFormatter implements OutputFormatter {
  private lines: string[] = [];

  setContext(_context: OutputFormatterContext): void {
    // The raw ACP stream already carries session ids.
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.lines.push(`${JSON.stringify(message)}\n`);
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
    this.lines.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: params.message,
          data: {
            acpxCode: params.code,
            detailCode: params.detailCode,
            origin: params.origin,
            retryable: params.retryable,
            timestamp: params.timestamp,
            acp: params.acp,
          },
        },
      })}\n`,
    );
  }

  onPermissionEscalation(_event: PermissionEscalationEvent): void {
    // Permission details are represented by the ACP request/response messages.
  }

  flush(): void {
    // no-op
  }

  async writeToFile(filePath: string): Promise<void> {
    await fs.writeFile(filePath, this.lines.join(""), "utf8");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
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

function compareRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeAgentFileName(agent: string): string {
  return encodeURIComponent(agent).replace(/%/g, "_");
}

async function readPromptInput(
  filePath: string | undefined,
  promptText: string,
  cwd: string,
): Promise<PromptInput> {
  if (!filePath) {
    if (promptText.trim().length === 0) {
      throw new InvalidArgumentError("Prompt is required unless --prompt-file is provided");
    }
    return textPrompt(promptText);
  }

  const source =
    filePath === "-" ? await readStdin() : await fs.readFile(path.resolve(cwd, filePath), "utf8");
  const prompt = mergePromptSourceWithText(source, promptText);
  if (prompt.length === 0) {
    throw new InvalidArgumentError("Prompt from --prompt-file is empty");
  }
  return prompt;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function summarizeTranscript(transcriptPath: string): Promise<TranscriptSummary> {
  const content = await fs.readFile(transcriptPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  let finalMessage = "";
  let stopReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let contextUsed: number | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const message = asRecord(parsed);
    const params = asRecord(message?.params);
    const update = asRecord(params?.update);
    if (message && Object.hasOwn(message, "result")) {
      const result = asRecord(message.result);
      if (typeof result?.stopReason === "string") {
        stopReason = result.stopReason;
      }
    }

    if (message?.method !== "session/update" || !update) {
      continue;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      const contentBlock = asRecord(update.content);
      if (contentBlock?.type === "text" && typeof contentBlock.text === "string") {
        finalMessage += contentBlock.text;
      }
      continue;
    }

    if (update.sessionUpdate === "usage_update") {
      const usageMeta = asRecord(asRecord(update._meta)?.usage);
      const source = usageMeta ?? update;
      inputTokens = readNumber(source, ["input_tokens", "inputTokens", "input", "used"]);
      outputTokens = readNumber(source, ["output_tokens", "outputTokens", "output"]);
      contextUsed = readNumber(source, ["context_used", "contextUsed", "size", "used"]);
    }
  }

  return {
    stopReason,
    inputTokens,
    outputTokens,
    contextUsed,
    finalMessage: collapseWhitespace(finalMessage),
  };
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
  promptFile: string | undefined,
  command: Command,
): {
  agents: string[];
  promptText: string;
} {
  if (promptFile) {
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

function resolveCompareCwd(command: Command, flags: CompareFlags): string {
  const opts = command.optsWithGlobals() as { cwd?: unknown };
  const cwd =
    typeof flags.cwd === "string"
      ? flags.cwd
      : typeof opts.cwd === "string"
        ? opts.cwd
        : process.cwd();
  return path.resolve(cwd);
}

function resolveCompareTimeout(command: Command, flags: CompareFlags): number {
  const opts = command.optsWithGlobals() as { timeout?: unknown };
  if (typeof flags.timeout === "number") {
    return flags.timeout;
  }
  if (typeof opts.timeout === "number") {
    return opts.timeout;
  }
  return DEFAULT_COMPARE_TIMEOUT_MS;
}

function resolveComparePermissionMode(command: Command, flags: CompareFlags): PermissionMode {
  const opts = command.optsWithGlobals() as {
    approveAll?: unknown;
    approveReads?: unknown;
    denyAll?: unknown;
  };
  return resolvePermissionMode(
    {
      approveAll: flags.approveAll === true || opts.approveAll === true ? true : undefined,
      approveReads: flags.approveReads === true || opts.approveReads === true ? true : undefined,
      denyAll: flags.denyAll === true || opts.denyAll === true ? true : undefined,
    },
    "deny-all",
  );
}

async function prepareWorktree(agent: string, cwd: string, runId: string): Promise<WorktreeInfo> {
  const rootResult = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = rootResult.stdout.trim();
  const relativeCwd = path.relative(root, cwd);
  const worktreePath = path.join(os.tmpdir(), `acpx-compare-${runId}-${safeAgentFileName(agent)}`);
  await fs.rm(worktreePath, { recursive: true, force: true });
  await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", worktreePath, "HEAD"]);
  return {
    root,
    worktreePath,
    cwd: path.resolve(worktreePath, relativeCwd),
  };
}

async function collectDiff(
  agent: string,
  transcriptDir: string,
  worktree: WorktreeInfo | undefined,
): Promise<Pick<CompareRow, "diff_stat" | "diff_path">> {
  if (!worktree) {
    return { diff_stat: null, diff_path: null };
  }

  const diffPath = path.join(transcriptDir, `${safeAgentFileName(agent)}.diff`);
  const [stat, diff] = await Promise.all([
    execFileAsync("git", ["-C", worktree.worktreePath, "diff", "--stat"]).catch(
      (error: unknown) => ({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }),
    ),
    execFileAsync("git", ["-C", worktree.worktreePath, "diff"]).catch((error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const diffContent = diff.stdout || diff.stderr || "";
  await fs.writeFile(diffPath, diffContent, "utf8");

  return {
    diff_stat: collapseWhitespace(stat.stdout || stat.stderr || "no changes"),
    diff_path: diffPath,
  };
}

async function removeWorktree(worktree: WorktreeInfo | undefined): Promise<void> {
  if (!worktree) {
    return;
  }
  await execFileAsync("git", [
    "-C",
    worktree.root,
    "worktree",
    "remove",
    "--force",
    worktree.worktreePath,
  ]).catch(() => undefined);
}

async function runAgentForCompare(
  agent: string,
  prompt: PromptInput,
  options: CompareOptions,
  config: ResolvedAcpxConfig,
): Promise<CompareRow> {
  const transcriptPath = path.join(options.transcriptDir, `${safeAgentFileName(agent)}.ndjson`);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  let worktree: WorktreeInfo | undefined;
  const formatter = new TranscriptFormatter();
  const t0 = performance.now();
  let status: CompareRow["status"] = "ok";
  let error: string | null = null;

  try {
    worktree = options.diff ? await prepareWorktree(agent, options.cwd, options.runId) : undefined;
    const agentCommand = resolveAgentCommand(agent, config.agents);
    const result = await runOnce({
      agentCommand,
      cwd: worktree?.cwd ?? options.cwd,
      prompt,
      mcpServers: config.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: config.nonInteractivePermissions,
      authCredentials: config.auth,
      authPolicy: config.authPolicy,
      outputFormatter: formatter,
      suppressSdkConsoleErrors: true,
      timeoutMs: options.timeoutMs,
    });
    if (result.stopReason === "cancelled") {
      status = "cancelled";
    }
  } catch (caught) {
    status = caught instanceof TimeoutError ? "cancelled" : "error";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await formatter.writeToFile(transcriptPath);
  }

  const wallMs = Math.round(performance.now() - t0);
  const [summary, diff] = await Promise.all([
    summarizeTranscript(transcriptPath),
    collectDiff(agent, options.transcriptDir, worktree),
  ]);
  await removeWorktree(worktree);

  return {
    agent,
    status,
    stop_reason: summary.stopReason,
    wall_ms: wallMs,
    input_tokens: summary.inputTokens,
    output_tokens: summary.outputTokens,
    context_used: summary.contextUsed,
    final_message: truncate(summary.finalMessage, FINAL_MESSAGE_PREVIEW_CHARS),
    transcript_path: transcriptPath,
    error: error ? truncate(collapseWhitespace(error), FINAL_MESSAGE_PREVIEW_CHARS) : null,
    diff_stat: diff.diff_stat,
    diff_path: diff.diff_path,
  };
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

function renderTable(rows: CompareRow[], includeDiff: boolean): string {
  const headers = [
    "agent",
    "status",
    "wall_ms",
    "input",
    "output",
    "context",
    "stop_reason",
    "final_message",
    "transcript",
    ...(includeDiff ? ["diff"] : []),
    "error",
  ];
  const body = rows.map((row) => [
    row.agent,
    row.status,
    row.wall_ms,
    row.input_tokens,
    row.output_tokens,
    row.context_used,
    row.stop_reason,
    row.final_message,
    row.transcript_path,
    ...(includeDiff ? [row.diff_stat] : []),
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

export function registerCompareCommand(program: Command, config: ResolvedAcpxConfig): void {
  program
    .command("compare")
    .description("Run one prompt across multiple agents and compare the results")
    .argument("<args...>", "Agents followed by prompt text, or agents with --prompt-file")
    .option("--cwd <dir>", "Target workspace")
    .option("--approve-all", "Auto-approve all permission requests")
    .option("--approve-reads", "Auto-approve read/search requests and prompt for writes")
    .option("--deny-all", "Deny all permission requests")
    .option("--timeout <seconds>", "Per-agent timeout in seconds", parseTimeoutSeconds)
    .option("--json", "Emit CompareRow[] as JSON")
    .option("--diff", "Run each agent in an isolated git worktree and report diff summaries")
    .option(
      "-f, --prompt-file <path>",
      "Read prompt text from file path (use - for stdin)",
      (value: string) => parseNonEmptyValue("Prompt file", value),
    )
    .action(async function (this: Command, args: string[], flags: CompareFlags) {
      if (config.disableExec) {
        throw new Error("compare subcommand is disabled by configuration (disableExec: true)");
      }

      const cwd = resolveCompareCwd(this, flags);
      const { agents, promptText } = splitCompareArgs(args, flags.promptFile, this);
      const prompt = await readPromptInput(flags.promptFile, promptText, cwd);
      const runId = compareRunId();
      const transcriptDir = path.join(os.homedir(), ".acpx", "compare", runId);
      const permissionMode = resolveComparePermissionMode(this, flags);
      const timeoutMs = resolveCompareTimeout(this, flags);

      const rows = await Promise.all(
        agents.map((agent) =>
          runAgentForCompare(
            agent,
            prompt,
            {
              cwd,
              runId,
              permissionMode,
              timeoutMs,
              diff: flags.diff === true,
              transcriptDir,
            },
            config,
          ).catch((error: unknown) => ({
            agent,
            status: "error" as const,
            stop_reason: null,
            wall_ms: 0,
            input_tokens: null,
            output_tokens: null,
            context_used: null,
            final_message: "",
            transcript_path: path.join(transcriptDir, `${safeAgentFileName(agent)}.ndjson`),
            error: error instanceof Error ? error.message : String(error),
            diff_stat: null,
            diff_path: null,
          })),
        ),
      );

      if (flags.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${renderTable(rows, flags.diff === true)}\n`);
    });
}
