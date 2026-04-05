import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../../types.js";

export type QueueOwnerRuntimeOptions = {
  sessionId: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
};

type SessionSendLike = {
  sessionId: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
};

export function sanitizeQueueOwnerExecArgv(
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index];
    if (value === "--experimental-test-coverage" || value === "--test") {
      continue;
    }
    if (
      value === "--test-name-pattern" ||
      value === "--test-reporter" ||
      value === "--test-reporter-destination"
    ) {
      index += 1;
      continue;
    }
    if (value.startsWith("--test-")) {
      continue;
    }
    if (
      value === "--inspect" ||
      value === "--inspect-brk" ||
      value === "--inspect-port" ||
      value === "--inspect-publish-uid" ||
      value.startsWith("--inspect=") ||
      value.startsWith("--inspect-brk=") ||
      value.startsWith("--inspect-port=") ||
      value.startsWith("--inspect-publish-uid=") ||
      value === "--debug-port" ||
      value.startsWith("--debug-port=")
    ) {
      if (
        value === "--inspect" ||
        value === "--inspect-brk" ||
        value === "--inspect-port" ||
        value === "--inspect-publish-uid" ||
        value === "--debug-port"
      ) {
        index += 1;
      }
      continue;
    }
    sanitized.push(value);
  }
  return sanitized;
}

export function buildQueueOwnerArgOverride(
  entryPath: string,
  execArgv: readonly string[] = process.execArgv,
): string | null {
  const sanitized = sanitizeQueueOwnerExecArgv(execArgv);
  if (sanitized.length === 0) {
    return null;
  }
  return JSON.stringify([...sanitized, entryPath, "__queue-owner"]);
}

export function resolveQueueOwnerSpawnArgs(argv: readonly string[] = process.argv): string[] {
  const override = process.env.ACPX_QUEUE_OWNER_ARGS;
  if (override) {
    const parsed = JSON.parse(override) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((value) => typeof value === "string" && value.length > 0)
    ) {
      return [...parsed];
    }
    throw new Error("acpx self-spawn failed: invalid ACPX_QUEUE_OWNER_ARGS");
  }

  const entry = argv[1];
  if (!entry || entry.trim().length === 0) {
    throw new Error("acpx self-spawn failed: missing CLI entry path");
  }
  const resolvedEntry = realpathSync(entry);
  return [resolvedEntry, "__queue-owner"];
}

export function queueOwnerRuntimeOptionsFromSend(
  options: SessionSendLike,
): QueueOwnerRuntimeOptions {
  return {
    sessionId: options.sessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    ttlMs: options.ttlMs,
    maxQueueDepth: options.maxQueueDepth,
    promptRetries: options.promptRetries,
  };
}

export function buildQueueOwnerSpawnOptions(payload: string): {
  detached: true;
  stdio: "ignore";
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ACPX_QUEUE_OWNER_PAYLOAD: payload,
    },
    windowsHide: true,
  };
}

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): void {
  const payload = JSON.stringify(options);
  const child = spawn(
    process.execPath,
    resolveQueueOwnerSpawnArgs(),
    buildQueueOwnerSpawnOptions(payload),
  );
  child.unref();
}
