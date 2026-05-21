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

    if (token === "--cwd") {
      const next = argv[index + 1];
      if (next && next !== "--") {
        return path.resolve(next);
      }
      break;
    }

    if (token.startsWith("--cwd=")) {
      const value = token.slice("--cwd=".length).trim();
      if (value.length > 0) {
        return path.resolve(value);
      }
      break;
    }

    if (token === "--") {
      break;
    }
  }

  return process.cwd();
}

function detectRequestedOutputFormat(argv: string[], fallback: OutputFormat): OutputFormat {
  let detectedFormat = fallback;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      break;
    }

    if (isJsonStrictToken(token)) {
      return "json";
    }

    const format = readFormatFlagValue(token, argv[index + 1]);
    if (format) {
      detectedFormat = format;
    }
  }

  return detectedFormat;
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

    if (token === "--") {
      break;
    }

    if (isJsonStrictToken(token)) {
      return true;
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
  const rawArgs = argv.slice(2);

  if (await handleQueueOwnerCommand(argv)) {
    return;
  }

  if (isTopLevelVersionRequest(rawArgs)) {
    process.stdout.write(`${getAcpxVersion()}\n`);
    return;
  }

  await maybeHandleSkillflag(argv);

  const config = await loadResolvedConfig(detectInitialCwd(rawArgs));
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
        await program.parseAsync(argv);
      } catch (error) {
        await handleProgramParseError(error, requestedOutputPolicy);
      }
    });
  } finally {
    flushPerfMetricsCapture();
  }
}
