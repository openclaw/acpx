import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionAgentOptions } from "../../runtime/engine/session-options.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../../types.js";

const QUEUE_OWNER_PAYLOAD_FILE_ENV = "ACPX_QUEUE_OWNER_PAYLOAD_FILE";
const QUEUE_OWNER_PAYLOAD_ENV = "ACPX_QUEUE_OWNER_PAYLOAD";

export type QueueOwnerRuntimeOptions = {
  sessionId: string;
  mcpServers?: McpServer[];
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
};

type SessionSendLike = {
  sessionId: string;
  mcpServers?: McpServer[];
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
};

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

const NODE_TEST_FLAGS = new Set([
  "--experimental-test-coverage",
  "--test",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);

const NODE_TEST_FLAGS_WITH_VALUE = new Set([
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);

const INSPECTOR_FLAGS_WITH_VALUE = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-publish-uid",
  "--debug-port",
]);

const INSPECTOR_FLAG_PREFIXES = [
  "--inspect=",
  "--inspect-brk=",
  "--inspect-port=",
  "--inspect-publish-uid=",
  "--debug-port=",
];

type ExecArgvDecision = "keep" | "drop" | "drop-with-value";

function classifyExecArgv(value: string | undefined): ExecArgvDecision {
  if (value === undefined) {
    return "drop";
  }
  if (NODE_TEST_FLAGS_WITH_VALUE.has(value) || INSPECTOR_FLAGS_WITH_VALUE.has(value)) {
    return "drop-with-value";
  }
  return dropSingleExecArgv(value) ? "drop" : "keep";
}

function dropSingleExecArgv(value: string): boolean {
  return (
    NODE_TEST_FLAGS.has(value) ||
    value.startsWith("--test-") ||
    INSPECTOR_FLAG_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

export function sanitizeQueueOwnerExecArgv(
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index] ?? "";
    const decision = classifyExecArgv(value);
    if (decision === "drop") {
      continue;
    }
    if (decision === "drop-with-value") {
      index += 1;
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
    if (isNonEmptyStringArray(parsed)) {
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
    ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
    ...(options.mcpConfigFingerprint ? { mcpConfigFingerprint: options.mcpConfigFingerprint } : {}),
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    ttlMs: options.ttlMs,
    maxQueueDepth: options.maxQueueDepth,
    promptRetries: options.promptRetries,
    sessionOptions: options.sessionOptions,
  };
}

export function writeQueueOwnerPayloadFile(payload: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-queue-owner-"));
  const payloadPath = path.join(dir, "payload.json");
  writeFileSync(payloadPath, payload, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return payloadPath;
}

export function buildQueueOwnerSpawnOptions(payloadFilePath: string): {
  detached: true;
  stdio: "ignore";
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [QUEUE_OWNER_PAYLOAD_FILE_ENV]: payloadFilePath,
  };
  delete env[QUEUE_OWNER_PAYLOAD_ENV];
  return {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: true,
  };
}

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): void {
  const payload = JSON.stringify(options);
  const payloadPath = writeQueueOwnerPayloadFile(payload);
  const child = spawn(
    process.execPath,
    resolveQueueOwnerSpawnArgs(),
    buildQueueOwnerSpawnOptions(payloadPath),
  );
  child.unref();
}
