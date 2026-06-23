#!/usr/bin/env node

import path from "node:path";
import { Command, CommanderError } from "commander";
import {
  exitCodeForOutputErrorCode,
  normalizeOutputError,
  type NormalizedOutputError,
} from "./acp/error-normalization.js";
import { listBuiltInAgents } from "./agent-registry.js";
import { InterruptedError } from "./async-control.js";
import { configurePublicCli } from "./cli-public.js";
import { handlePrompt } from "./cli/command-handlers.js";
import { registerAgentCommand, registerDefaultCommands } from "./cli/command-registration.js";
import { loadResolvedConfig } from "./cli/config.js";
import {
  addGlobalFlags,
  parseAllowedTools,
  parseMaxTurns,
  parseTtlSeconds,
  resolveOutputPolicy,
} from "./cli/flags.js";
import { createOutputFormatter, getTextErrorRemediationHints } from "./cli/output/output.js";
import { runQueueOwnerFromEnv } from "./cli/queue/owner-env.js";
import { flushPerfMetricsCapture, installPerfMetricsCapture } from "./perf-metrics-capture.js";
import { EXIT_CODES, OUTPUT_FORMATS, type OutputFormat, type OutputPolicy } from "./types.js";
import { getAcpxVersion } from "./version.js";

export { parseAllowedTools, parseMaxTurns, parseTtlSeconds };
export { formatPromptSessionBannerLine } from "./cli/output/render.js";

type SkillflagModule = typeof import("skillflag");

const TOP_LEVEL_VERBS = new Set([
  "prompt",
  "exec",
  "cancel",
  "compare",
  "flow",
  "set-mode",
  "set",
  "sessions",
  "status",
  "config",
  "help",
]);

const TOP_LEVEL_VERSION_VALUE_FLAG_VALUES = [
  "--agent",
  "--cwd",
  "--auth-policy",
  "--non-interactive-permissions",
  "--permission-policy",
  "--policy",
  "--format",
  "--model",
  "--allowed-tools",
  "--max-turns",
  "--system-prompt",
  "--append-system-prompt",
  "--prompt-retries",
  "--timeout",
  "--ttl",
  "--mcp-config",
] as const;

const TOP_LEVEL_VERSION_VALUE_FLAGS = new Set<string>(TOP_LEVEL_VERSION_VALUE_FLAG_VALUES);

const TOP_LEVEL_VERSION_BOOLEAN_FLAGS = new Set([
  "--approve-all",
  "--approve-reads",
  "--deny-all",
  "--suppress-reads",
  "--json-strict",
  "--no-terminal",
  "--verbose",
]);

const AGENT_SCAN_VALUE_FLAG_VALUES = [...TOP_LEVEL_VERSION_VALUE_FLAG_VALUES, "--file"] as const;

const AGENT_SCAN_VALUE_FLAGS = new Set<string>(AGENT_SCAN_VALUE_FLAG_VALUES);

const AGENT_SCAN_BOOLEAN_FLAGS = new Set<string>(TOP_LEVEL_VERSION_BOOLEAN_FLAGS);

let skillflagModulePromise: Promise<SkillflagModule> | undefined;

type TopLevelFlagStep = {
  stop: boolean;
  skipNext: boolean;
};

function loadSkillflagModule(): Promise<SkillflagModule> {
  skillflagModulePromise ??= import("skillflag");
  return skillflagModulePromise;
}

function shouldMaybeHandleSkillflag(argv: string[]): boolean {
  return argv.some((token) => token === "--skill" || token.startsWith("--skill="));
}

type AgentTokenScan = {
  token?: string;
  hasAgentOverride: boolean;
};

type AgentTokenStep = {
  result?: AgentTokenScan;
  indexDelta: number;
  hasAgentOverride?: true;
};

type AgentTokenFlagScan = "agent-value" | "skip-next" | "skip" | "unknown";

function matchesLongFlagValue(token: string, flags: Iterable<string>): boolean {
  for (const flag of flags) {
    if (token.startsWith(`${flag}=`)) {
      return true;
    }
  }
  return false;
}

function classifyAgentTokenFlag(token: string): AgentTokenFlagScan {
  if (token === "--agent" || token.startsWith("--agent=")) {
    return "agent-value";
  }
  if (AGENT_SCAN_VALUE_FLAGS.has(token)) {
    return "skip-next";
  }
  if (
    AGENT_SCAN_BOOLEAN_FLAGS.has(token) ||
    matchesLongFlagValue(token, AGENT_SCAN_VALUE_FLAGS) ||
    token.startsWith("--json-strict=")
  ) {
    return "skip";
  }
  return "unknown";
}

function scanAgentTokenStep(token: string, hasAgentOverride: boolean): AgentTokenStep {
  if (token === "--") {
    return { result: { hasAgentOverride }, indexDelta: 0 };
  }
  if (!token.startsWith("-") || token === "-") {
    return { result: { token, hasAgentOverride }, indexDelta: 0 };
  }

  const flagScan = classifyAgentTokenFlag(token);
  if (flagScan === "agent-value") {
    return { indexDelta: token === "--agent" ? 1 : 0, hasAgentOverride: true };
  }
  if (flagScan === "skip-next") {
    return { indexDelta: 1 };
  }
  if (flagScan === "skip") {
    return { indexDelta: 0 };
  }
  return { result: { hasAgentOverride }, indexDelta: 0 };
}

function detectAgentToken(argv: string[]): AgentTokenScan {
  let hasAgentOverride = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const step = scanAgentTokenStep(token, hasAgentOverride);
    if (step.result) {
      return step.result;
    }
    if (step.hasAgentOverride) {
      hasAgentOverride = true;
    }
    index += step.indexDelta;
  }

  return { hasAgentOverride };
}

function detectInitialCwd(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    const scan = classifyTopLevelFlagScan(token);
    if (scan.stop) {
      break;
    }

    const cwd = readCwdFlagValue(token, argv[index + 1]);
    if (cwd) {
      return path.resolve(cwd);
    }
    if (isCwdFlagToken(token)) {
      break;
    }

    if (scan.skipNext) {
      index += 1;
    }
  }

  return process.cwd();
}

function detectMcpConfigPath(argv: string[], cwd: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const scan = scanMcpConfigToken(argv[index], argv[index + 1], cwd);
    if (scan.stop) {
      return scan.path;
    }
    if (scan.skipNext) {
      index += 1;
    }
  }
  return undefined;
}

function scanMcpConfigToken(
  token: string,
  nextToken: string | undefined,
  cwd: string,
): { path?: string; skipNext?: boolean; stop?: boolean } {
  if (token === "--" || !token.startsWith("-") || token === "-") {
    return { stop: true };
  }
  if (token === "--mcp-config") {
    return { path: resolveMcpConfigPath(nextToken, cwd), stop: true };
  }
  if (token.startsWith("--mcp-config=")) {
    return { path: resolveMcpConfigPath(token.slice("--mcp-config=".length), cwd), stop: true };
  }
  return { skipNext: TOP_LEVEL_VERSION_VALUE_FLAGS.has(token) };
}

function resolveMcpConfigPath(value: string | undefined, cwd: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "--" ? path.resolve(cwd, trimmed) : undefined;
}

function isCwdFlagToken(token: string): boolean {
  return token === "--cwd" || token.startsWith("--cwd=");
}

function readCwdFlagValue(token: string, nextToken: string | undefined): string | undefined {
  const raw = token === "--cwd" ? nextToken : readInlineFlagValue(token, "--cwd");
  const value = raw?.trim();
  if (!value || value === "--") {
    return undefined;
  }
  return value;
}

function detectRequestedOutputFormat(argv: string[], fallback: OutputFormat): OutputFormat {
  let detectedFormat = fallback;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    const scan = classifyTopLevelFlagScan(token);
    if (scan.stop) {
      break;
    }

    if (isJsonStrictToken(token)) {
      return "json";
    }

    const format = readFormatFlagValue(token, argv[index + 1]);
    if (format) {
      detectedFormat = format;
    }

    if (scan.skipNext) {
      index += 1;
    }
  }

  return detectedFormat;
}

function classifyTopLevelFlagScan(token: string): TopLevelFlagStep {
  if (token === "--" || !token.startsWith("-") || token === "-") {
    return { stop: true, skipNext: false };
  }
  return {
    stop: false,
    skipNext: TOP_LEVEL_VERSION_VALUE_FLAGS.has(token),
  };
}

function readFormatFlagValue(
  token: string,
  nextToken: string | undefined,
): OutputFormat | undefined {
  const raw = token === "--format" ? nextToken : readInlineFlagValue(token, "--format");
  return isOutputFormat(raw) ? raw : undefined;
}

function readInlineFlagValue(token: string, flag: string): string | undefined {
  if (!token.startsWith(`${flag}=`)) {
    return undefined;
  }
  return token.slice(flag.length + 1).trim();
}

function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat);
}

function isJsonStrictToken(token: string): boolean {
  return token === "--json-strict" || token.startsWith("--json-strict=");
}

function detectJsonStrict(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    const scan = classifyTopLevelFlagScan(token);
    if (scan.stop) {
      break;
    }

    if (isJsonStrictToken(token)) {
      return true;
    }

    if (scan.skipNext) {
      index += 1;
    }
  }

  return false;
}

function shouldSkipTopLevelVersionToken(token: string): boolean {
  return (
    matchesLongFlagValue(token, TOP_LEVEL_VERSION_VALUE_FLAG_VALUES) ||
    TOP_LEVEL_VERSION_BOOLEAN_FLAGS.has(token)
  );
}

function topLevelVersionTokenDecision(token: string): "version" | "stop" | "skip-next" | "skip" {
  if (token === "--version" || token === "-V") {
    return "version";
  }
  if (!token.startsWith("-") || token === "-") {
    return "stop";
  }
  if (TOP_LEVEL_VERSION_VALUE_FLAGS.has(token)) {
    return "skip-next";
  }
  if (shouldSkipTopLevelVersionToken(token)) {
    return "skip";
  }
  return "stop";
}

function isTopLevelVersionRequest(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      return false;
    }

    const decision = topLevelVersionTokenDecision(token);
    if (decision === "version") {
      return true;
    }
    if (decision === "stop") {
      return false;
    }
    if (decision === "skip-next") {
      index += 1;
    }
  }

  return false;
}

async function emitJsonErrorEvent(error: NormalizedOutputError): Promise<void> {
  const formatter = createOutputFormatter("json", {
    jsonContext: {
      sessionId: "unknown",
    },
    suppressReads: false,
  });
  formatter.onError(error);
  formatter.flush();
}

function isOutputAlreadyEmitted(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
}

async function emitRequestedError(
  error: unknown,
  normalized: NormalizedOutputError,
  outputPolicy: OutputPolicy,
): Promise<void> {
  if (isOutputAlreadyEmitted(error)) {
    return;
  }

  if (outputPolicy.format === "json") {
    await emitJsonErrorEvent(normalized);
    return;
  }

  if (!outputPolicy.suppressNonJsonStderr) {
    process.stderr.write(`${normalized.message}\n`);
    if (outputPolicy.format === "text") {
      for (const hint of getTextErrorRemediationHints(normalized)) {
        process.stderr.write(`${hint}\n`);
      }
    }
  }
}

async function runWithOutputPolicy<T>(
  _outputPolicy: OutputPolicy,
  run: () => Promise<T>,
): Promise<T> {
  return await run();
}

async function handleQueueOwnerCommand(argv: string[]): Promise<boolean> {
  installPerfMetricsCapture({
    argv: argv.slice(2),
    role: argv[2] === "__queue-owner" ? "queue_owner" : "cli",
  });

  if (argv[2] !== "__queue-owner") {
    return false;
  }

  try {
    await runQueueOwnerFromEnv(process.env);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[acpx] queue owner failed: ${message}\n`);
    process.exit(EXIT_CODES.ERROR);
    return true;
  }
}

async function maybeHandleSkillflag(argv: string[]): Promise<void> {
  if (!shouldMaybeHandleSkillflag(argv)) {
    return;
  }

  const { findSkillsRoot, maybeHandleSkillflag } = await loadSkillflagModule();
  await maybeHandleSkillflag(argv, {
    skillsRoot: findSkillsRoot(import.meta.url),
    includeBundledSkill: false,
  });
}

function createProgram(requestedJsonStrict: boolean): Command {
  const program = new Command();
  program
    .name("acpx")
    .description("Headless CLI client for the Agent Client Protocol")
    .version(getAcpxVersion())
    .enablePositionalOptions()
    .showHelpAfterError();

  if (requestedJsonStrict) {
    program.configureOutput({
      writeOut: () => {
        // json-strict intentionally suppresses non-JSON stdout output.
      },
      writeErr: () => {
        // json-strict intentionally suppresses non-JSON stderr output.
      },
    });
  }

  return program;
}

async function handleProgramParseError(
  error: unknown,
  requestedOutputPolicy: OutputPolicy,
): Promise<never> {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exit(EXIT_CODES.SUCCESS);
    }

    const normalized = normalizeOutputError(error, {
      defaultCode: "USAGE",
      origin: "cli",
    });
    await emitRequestedError(error, normalized, requestedOutputPolicy);
    process.exit(exitCodeForOutputErrorCode(normalized.code));
  }

  if (error instanceof InterruptedError) {
    process.exit(EXIT_CODES.INTERRUPTED);
  }

  const normalized = normalizeOutputError(error, {
    origin: "cli",
  });
  await emitRequestedError(error, normalized, requestedOutputPolicy);
  process.exit(exitCodeForOutputErrorCode(normalized.code));
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const rawArgs = normalizeLifecycleScriptArgs(argv.slice(2));
  const normalizedArgv = [argv[0] ?? "node", argv[1] ?? "acpx", ...rawArgs];

  if (await handleQueueOwnerCommand(argv)) {
    return;
  }

  if (isTopLevelVersionRequest(rawArgs)) {
    process.stdout.write(`${getAcpxVersion()}\n`);
    return;
  }

  await maybeHandleSkillflag(normalizedArgv);

  const initialCwd = detectInitialCwd(rawArgs);
  const config = await loadResolvedConfig(initialCwd, {
    mcpConfigPath: detectMcpConfigPath(rawArgs, initialCwd),
  });
  const requestedJsonStrict = detectJsonStrict(rawArgs);
  const requestedOutputFormat = detectRequestedOutputFormat(rawArgs, config.format);
  const requestedOutputPolicy = {
    ...resolveOutputPolicy(requestedOutputFormat, requestedJsonStrict),
    suppressReads: rawArgs.some((token) => token === "--suppress-reads"),
  };

  const program = createProgram(requestedJsonStrict);

  addGlobalFlags(program);

  configurePublicCli({
    program,
    argv: rawArgs,
    config,
    requestedJsonStrict,
    topLevelVerbs: TOP_LEVEL_VERBS,
    listBuiltInAgents,
    detectAgentToken,
    registerAgentCommand,
    registerDefaultCommands,
    handlePromptAction: async (command, promptParts) => {
      await handlePrompt(undefined, promptParts, {}, command, config);
    },
  });

  program.exitOverride((error) => {
    throw error;
  });

  try {
    await runWithOutputPolicy(requestedOutputPolicy, async () => {
      try {
        await program.parseAsync(normalizedArgv);
      } catch (error) {
        await handleProgramParseError(error, requestedOutputPolicy);
      }
    });
  } finally {
    flushPerfMetricsCapture();
  }
}

function normalizeLifecycleScriptArgs(rawArgs: string[]): string[] {
  if (
    rawArgs[0] === "--" &&
    (process.env.npm_lifecycle_event || process.env.npm_lifecycle_script)
  ) {
    return rawArgs.slice(1);
  }
  return rawArgs;
}
