import { spawn } from "node:child_process";
import { CopilotAcpUnsupportedError } from "../errors.js";
import { buildSpawnCommandOptions } from "../spawn-command-options.js";
import { type AcpClientOptions } from "../types.js";
import { basenameToken, splitCommandLine } from "./client-process.js";

const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15_000;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 60_000;
const GEMINI_VERSION_TIMEOUT_MS = 2_000;
const GEMINI_ACP_FLAG_VERSION = [0, 33, 0] as const;
const COPILOT_HELP_TIMEOUT_MS = 2_000;

type GeminiVersion = {
  raw: string;
  parts: [number, number, number];
};

const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

export function resolveAgentCloseAfterStdinEndMs(agentCommand: string): number {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli"
    ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS
    : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}

export function shouldIgnoreNonJsonAgentOutputLine(
  agentCommand: string,
  trimmedLine: string,
): boolean {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}

export function isGeminiAcpCommand(command: string, args: readonly string[]): boolean {
  return (
    basenameToken(command) === "gemini" &&
    (args.includes("--acp") || args.includes("--experimental-acp"))
  );
}

export function isClaudeAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "claude-agent-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("claude-agent-acp"));
}

export function isCopilotAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "copilot" && args.includes("--acp");
}

export function isQoderAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "qodercli" && args.includes("--acp");
}

function hasCommandFlag(args: readonly string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

function normalizeQoderAllowedToolName(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "bash":
    case "glob":
    case "grep":
    case "ls":
    case "read":
    case "write":
      return tool.trim().toUpperCase();
    default:
      return tool.trim();
  }
}

export function buildQoderAcpCommandArgs(
  initialArgs: readonly string[],
  options: Pick<AcpClientOptions, "sessionOptions">,
): string[] {
  const args = [...initialArgs];
  const sessionOptions = options.sessionOptions;

  if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) {
    args.push(`--max-turns=${sessionOptions.maxTurns}`);
  }

  if (
    Array.isArray(sessionOptions?.allowedTools) &&
    !hasCommandFlag(args, "--allowed-tools") &&
    !hasCommandFlag(args, "--disallowed-tools")
  ) {
    const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
    args.push(`--allowed-tools=${encodedTools}`);
  }

  return args;
}

export function resolveGeminiAcpStartupTimeoutMs(): number {
  const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}

export function resolveClaudeAcpSessionCreateTimeoutMs(): number {
  const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}

function parseGeminiVersion(value: string | undefined): GeminiVersion | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }

  return {
    raw: normalized,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

async function detectGeminiVersion(command: string): Promise<GeminiVersion | undefined> {
  return await new Promise<GeminiVersion | undefined>((resolve) => {
    const child = spawn(
      command,
      ["--version"],
      buildSpawnCommandOptions(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: GeminiVersion | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, GEMINI_VERSION_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", () => {
      const versionLine = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /\d+\.\d+\.\d+/.test(line));
      finish(parseGeminiVersion(versionLine));
    });
  });
}

export async function resolveGeminiCommandArgs(
  command: string,
  args: readonly string[],
): Promise<string[]> {
  if (basenameToken(command) !== "gemini" || !args.includes("--acp")) {
    return [...args];
  }

  const version = await detectGeminiVersion(command);
  if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) {
    return args.map((arg) => (arg === "--acp" ? "--experimental-acp" : arg));
  }

  return [...args];
}

async function readCommandOutput(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(
      command,
      [...args],
      buildSpawnCommandOptions(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", () => {
      finish(`${stdout}\n${stderr}`);
    });
  });
}

export async function buildGeminiAcpStartupTimeoutMessage(command: string): Promise<string> {
  const parts = [
    "Gemini CLI ACP startup timed out before initialize completed.",
    "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior.",
  ];

  const version = await detectGeminiVersion(command);
  if (version) {
    parts.push(`Detected Gemini CLI version: ${version.raw}.`);
  }

  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
  }

  parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
  return parts.join(" ");
}

export function buildClaudeAcpSessionCreateTimeoutMessage(): string {
  return [
    "Claude ACP session creation timed out before session/new completed.",
    "This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
    "In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback.",
  ].join(" ");
}

async function buildCopilotAcpUnsupportedMessage(command: string): Promise<string> {
  const parts = [
    "GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.",
    "acpx copilot expects a Copilot CLI release that supports --acp --stdio.",
  ];

  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    parts.push("Detected copilot --help output without --acp support.");
  }

  parts.push(
    "Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.",
  );
  return parts.join(" ");
}

export async function ensureCopilotAcpSupport(command: string): Promise<void> {
  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    throw new CopilotAcpUnsupportedError(await buildCopilotAcpUnsupportedMessage(command), {
      retryable: false,
    });
  }
}

export function buildClaudeCodeOptionsMeta(
  options: AcpClientOptions["sessionOptions"],
): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }

  const claudeCodeOptions: Record<string, unknown> = {};
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    claudeCodeOptions.model = options.model;
  }
  if (Array.isArray(options.allowedTools)) {
    claudeCodeOptions.allowedTools = [...options.allowedTools];
  }
  if (typeof options.maxTurns === "number") {
    claudeCodeOptions.maxTurns = options.maxTurns;
  }

  const meta: Record<string, unknown> = {};
  if (Object.keys(claudeCodeOptions).length > 0) {
    meta.claudeCode = { options: claudeCodeOptions };
  }

  const systemPrompt = options.systemPrompt;
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    meta.systemPrompt = systemPrompt;
  } else if (
    systemPrompt &&
    typeof systemPrompt === "object" &&
    typeof systemPrompt.append === "string" &&
    systemPrompt.append.length > 0
  ) {
    meta.systemPrompt = { append: systemPrompt.append };
  }

  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}
