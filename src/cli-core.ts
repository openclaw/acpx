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
import { createOutputFormatter } from "./cli/output/output.js";
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

function detectAgentToken(argv: string[]): AgentTokenScan {
  let hasAgentOverride = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      return { token, hasAgentOverride };
    }

    if (token === "--agent") {
      hasAgentOverride = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--agent=")) {
      hasAgentOverride = true;
      continue;
    }

    if (
      token === "--cwd" ||
      token === "--auth-policy" ||
      token === "--non-interactive-permissions" ||
      token === "--format" ||
      token === "--model" ||
      token === "--allowed-tools" ||
      token === "--max-turns" ||
      token === "--timeout" ||
      token === "--ttl" ||
      token === "--file"
    ) {
      index += 1;
      continue;
    }

    if (
      token.startsWith("--cwd=") ||
      token.startsWith("--auth-policy=") ||
      token.startsWith("--non-interactive-permissions=") ||
      token.startsWith("--format=") ||
      token.startsWith("--model=") ||
      token.startsWith("--allowed-tools=") ||
      token.startsWith("--max-turns=") ||
      token.startsWith("--json-strict=") ||
      token.startsWith("--timeout=") ||
      token.startsWith("--ttl=") ||
      token.startsWith("--file=")
    ) {
      continue;
    }

    if (
      token === "--approve-all" ||
      token === "--approve-reads" ||
      token === "--deny-all" ||
      token === "--json-strict" ||
      token === "--verbose" ||
      token === "--suppress-reads"
    ) {
      continue;
    }

    return { hasAgentOverride };
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

    if (token === "--json-strict" || token.startsWith("--json-strict=")) {
      return "json";
    }

    if (token === "--format") {
      const raw = argv[index + 1];
      if (raw && OUTPUT_FORMATS.includes(raw as OutputFormat)) {
        detectedFormat = raw as OutputFormat;
      }
      continue;
    }

    if (token.startsWith("--format=")) {
      const raw = token.slice("--format=".length).trim();
      if (OUTPUT_FORMATS.includes(raw as OutputFormat)) {
        detectedFormat = raw as OutputFormat;
      }
    }
  }

  return detectedFormat;
}

function detectJsonStrict(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      break;
    }

    if (token === "--json-strict" || token.startsWith("--json-strict=")) {
      return true;
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
  }
}

async function runWithOutputPolicy<T>(
  _outputPolicy: OutputPolicy,
  run: () => Promise<T>,
): Promise<T> {
  return await run();
}

export async function main(argv: string[] = process.argv): Promise<void> {
  installPerfMetricsCapture({
    argv: argv.slice(2),
    role: argv[2] === "__queue-owner" ? "queue_owner" : "cli",
  });

  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${getAcpxVersion()}\n`);
    return;
  }

  if (argv[2] === "__queue-owner") {
    try {
      await runQueueOwnerFromEnv(process.env);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[acpx] queue owner failed: ${message}\n`);
      process.exit(EXIT_CODES.ERROR);
    }
  }

  if (shouldMaybeHandleSkillflag(argv)) {
    const { findSkillsRoot, maybeHandleSkillflag } = await loadSkillflagModule();
    await maybeHandleSkillflag(argv, {
      skillsRoot: findSkillsRoot(import.meta.url),
      includeBundledSkill: false,
    });
  }

  const rawArgs = argv.slice(2);
  const config = await loadResolvedConfig(detectInitialCwd(rawArgs));
  const requestedJsonStrict = detectJsonStrict(rawArgs);
  const requestedOutputFormat = detectRequestedOutputFormat(rawArgs, config.format);
  const requestedOutputPolicy = {
    ...resolveOutputPolicy(requestedOutputFormat, requestedJsonStrict),
    suppressReads: rawArgs.some((token) => token === "--suppress-reads"),
  };

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
    });
  } finally {
    flushPerfMetricsCapture();
  }
}
