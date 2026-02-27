import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import path from "node:path";
import {
  DEFAULT_AGENT_NAME,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
} from "../agent-registry.js";
import type { ResolvedAcpxConfig } from "../config.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "../session.js";
import {
  AUTH_POLICIES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  OUTPUT_FORMATS,
  type AuthPolicy,
  type NonInteractivePermissionPolicy,
  type OutputFormat,
  type OutputPolicy,
  type PermissionMode,
} from "../types.js";

export type PermissionFlags = {
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
};

export type GlobalFlags = PermissionFlags & {
  agent?: string;
  cwd: string;
  authPolicy?: AuthPolicy;
  nonInteractivePermissions: NonInteractivePermissionPolicy;
  jsonStrict?: boolean;
  timeout?: number;
  ttl: number;
  verbose?: boolean;
  format: OutputFormat;
};

export type PromptFlags = {
  session?: string;
  wait?: boolean;
  file?: string;
};

export type ExecFlags = {
  file?: string;
};

export type SessionsNewFlags = {
  name?: string;
};

export type SessionsHistoryFlags = {
  limit: number;
};

export type StatusFlags = {
  session?: string;
};

export function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format "${value}". Expected one of: ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return value as OutputFormat;
}

export function parseAuthPolicy(value: string): AuthPolicy {
  if (!AUTH_POLICIES.includes(value as AuthPolicy)) {
    throw new InvalidArgumentError(
      `Invalid auth policy "${value}". Expected one of: ${AUTH_POLICIES.join(", ")}`,
    );
  }
  return value as AuthPolicy;
}

export function parseNonInteractivePermissionPolicy(
  value: string,
): NonInteractivePermissionPolicy {
  if (
    !NON_INTERACTIVE_PERMISSION_POLICIES.includes(
      value as NonInteractivePermissionPolicy,
    )
  ) {
    throw new InvalidArgumentError(
      `Invalid non-interactive permission policy "${value}". Expected one of: ${NON_INTERACTIVE_PERMISSION_POLICIES.join(", ")}`,
    );
  }
  return value as NonInteractivePermissionPolicy;
}

export function parseTimeoutSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Timeout must be a positive number of seconds");
  }
  return Math.round(parsed * 1000);
}

export function parseTtlSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("TTL must be a non-negative number of seconds");
  }
  return Math.round(parsed * 1000);
}

export function parseSessionName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Session name must not be empty");
  }
  return trimmed;
}

export function parseNonEmptyValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(`${label} must not be empty`);
  }
  return trimmed;
}

export function parseHistoryLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }
  return parsed;
}

export function resolvePermissionMode(
  flags: PermissionFlags,
  defaultMode: PermissionMode,
): PermissionMode {
  const selected = [flags.approveAll, flags.approveReads, flags.denyAll].filter(
    Boolean,
  ).length;

  if (selected > 1) {
    throw new InvalidArgumentError(
      "Use only one permission mode: --approve-all, --approve-reads, or --deny-all",
    );
  }

  if (flags.approveAll) {
    return "approve-all";
  }
  if (flags.denyAll) {
    return "deny-all";
  }

  return defaultMode;
}

export function addGlobalFlags(command: Command): Command {
  return command
    .option("--agent <command>", "Raw ACP agent command (escape hatch)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option(
      "--auth-policy <policy>",
      "Authentication policy: skip or fail when auth is required",
      parseAuthPolicy,
    )
    .option("--approve-all", "Auto-approve all permission requests")
    .option(
      "--approve-reads",
      "Auto-approve read/search requests and prompt for writes",
    )
    .option("--deny-all", "Deny all permission requests")
    .option(
      "--non-interactive-permissions <policy>",
      "When prompting is unavailable: deny or fail",
      parseNonInteractivePermissionPolicy,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option(
      "--json-strict",
      "Strict JSON mode: requires --format json and suppresses non-JSON stderr output",
    )
    .option(
      "--timeout <seconds>",
      "Maximum time to wait for agent response",
      parseTimeoutSeconds,
    )
    .option(
      "--ttl <seconds>",
      "Queue owner idle TTL before shutdown (0 = keep alive forever) (default: 300)",
      parseTtlSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");
}

export function addSessionOption(command: Command): Command {
  return command
    .option(
      "-s, --session <name>",
      "Use named session instead of cwd default",
      parseSessionName,
    )
    .option(
      "--no-wait",
      "Queue prompt and return immediately when another prompt is already running",
    );
}

export function addSessionNameOption(command: Command): Command {
  return command.option(
    "-s, --session <name>",
    "Use named session instead of cwd default",
    parseSessionName,
  );
}

export function resolveSessionNameFromFlags(
  flags: StatusFlags,
  command: Command,
): string | undefined {
  if (flags.session) {
    return flags.session;
  }

  // Commander parses options on the parent command when flags appear before the
  // subcommand (e.g. `acpx codex -s foo cancel`). Use optsWithGlobals() so
  // subcommands can still access those values.
  const allOpts = (
    command as unknown as { optsWithGlobals?: () => unknown }
  ).optsWithGlobals?.();
  if (allOpts && typeof (allOpts as { session?: unknown }).session === "string") {
    return parseSessionName((allOpts as { session: string }).session);
  }

  const parentOpts = command.parent?.opts?.();
  if (parentOpts && typeof (parentOpts as { session?: unknown }).session === "string") {
    return parseSessionName((parentOpts as { session: string }).session);
  }

  return undefined;
}

export function addPromptInputOption(command: Command): Command {
  return command.option(
    "-f, --file <path>",
    "Read prompt text from file path (use - for stdin)",
  );
}

export function resolveGlobalFlags(
  command: Command,
  config: ResolvedAcpxConfig,
): GlobalFlags {
  const opts = command.optsWithGlobals() as Partial<GlobalFlags>;
  const format = opts.format ?? config.format ?? "text";
  const jsonStrict = opts.jsonStrict === true;
  const verbose = opts.verbose === true;

  if (jsonStrict && format !== "json") {
    throw new InvalidArgumentError("--json-strict requires --format json");
  }

  if (jsonStrict && verbose) {
    throw new InvalidArgumentError("--json-strict cannot be combined with --verbose");
  }

  return {
    agent: opts.agent,
    cwd: opts.cwd ?? process.cwd(),
    authPolicy: opts.authPolicy ?? config.authPolicy,
    nonInteractivePermissions:
      opts.nonInteractivePermissions ?? config.nonInteractivePermissions,
    jsonStrict,
    timeout: opts.timeout ?? config.timeoutMs,
    ttl: opts.ttl ?? config.ttlMs ?? DEFAULT_QUEUE_OWNER_TTL_MS,
    verbose,
    format,
    approveAll: opts.approveAll ? true : undefined,
    approveReads: opts.approveReads ? true : undefined,
    denyAll: opts.denyAll ? true : undefined,
  };
}

export function resolveOutputPolicy(
  format: OutputFormat,
  jsonStrict: boolean,
): OutputPolicy {
  return {
    format,
    jsonStrict,
    suppressNonJsonStderr: jsonStrict,
    queueErrorAlreadyEmitted: format !== "quiet",
    suppressSdkConsoleErrors: jsonStrict,
  };
}

export function resolveAgentInvocation(
  explicitAgentName: string | undefined,
  globalFlags: GlobalFlags,
  config: ResolvedAcpxConfig,
): {
  agentName: string;
  agentCommand: string;
  cwd: string;
} {
  const override = globalFlags.agent?.trim();
  if (override && explicitAgentName) {
    throw new InvalidArgumentError(
      "Do not combine positional agent with --agent override",
    );
  }

  const agentName = explicitAgentName ?? config.defaultAgent ?? DEFAULT_AGENT_NAME;
  const agentCommand =
    override && override.length > 0
      ? override
      : resolveAgentCommandFromRegistry(agentName, config.agents);

  return {
    agentName,
    agentCommand,
    cwd: path.resolve(globalFlags.cwd),
  };
}
