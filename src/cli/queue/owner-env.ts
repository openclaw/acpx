import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseOptionalMcpServers } from "../../mcp-servers.js";
import {
  runSessionQueueOwner,
  type QueueOwnerRuntimeOptions,
} from "../session/queue-owner-runtime.js";

const QUEUE_OWNER_PAYLOAD_FILE_ENV = "ACPX_QUEUE_OWNER_PAYLOAD_FILE";
const QUEUE_OWNER_PAYLOAD_ENV = "ACPX_QUEUE_OWNER_PAYLOAD";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

export function parseQueueOwnerPayload(raw: string): QueueOwnerRuntimeOptions {
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("queue owner payload must be an object");
  }

  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw new Error("queue owner payload missing sessionId");
  }
  if (
    record.permissionMode !== "approve-all" &&
    record.permissionMode !== "approve-reads" &&
    record.permissionMode !== "deny-all"
  ) {
    throw new Error("queue owner payload has invalid permissionMode");
  }

  const options: QueueOwnerRuntimeOptions = {
    sessionId: record.sessionId,
    permissionMode: record.permissionMode,
  };

  assignQueueOwnerTransportOptions(options, record);
  assignQueueOwnerScalarOptions(options, record);
  assignQueueOwnerSessionOptions(options, record.sessionOptions);

  return options;
}

function assignQueueOwnerTransportOptions(
  options: QueueOwnerRuntimeOptions,
  record: UnknownRecord,
): void {
  const parsedMcpServers = parseOptionalMcpServers(record.mcpServers, "queue owner payload");
  if (parsedMcpServers) {
    options.mcpServers = parsedMcpServers;
  }

  if (record.authCredentials && typeof record.authCredentials === "object") {
    const entries = Object.entries(record.authCredentials as UnknownRecord).filter(
      ([, value]) => typeof value === "string",
    ) as Array<[string, string]>;
    options.authCredentials = Object.fromEntries(entries);
  }
}

function assignQueueOwnerScalarOptions(
  options: QueueOwnerRuntimeOptions,
  record: UnknownRecord,
): void {
  if (record.nonInteractivePermissions === "deny" || record.nonInteractivePermissions === "fail") {
    options.nonInteractivePermissions = record.nonInteractivePermissions;
  }
  if (record.authPolicy === "skip" || record.authPolicy === "fail") {
    options.authPolicy = record.authPolicy;
  }
  assignBooleanOption(options, "terminal", record.terminal);
  assignBooleanOption(options, "suppressSdkConsoleErrors", record.suppressSdkConsoleErrors);
  assignBooleanOption(options, "verbose", record.verbose);
  assignFiniteNumberOption(options, "ttlMs", record.ttlMs);
  assignRoundedNumberOption(options, "maxQueueDepth", record.maxQueueDepth, 1);
  assignRoundedNumberOption(options, "promptRetries", record.promptRetries, 0);
}

function assignBooleanOption(
  options: QueueOwnerRuntimeOptions,
  key: "terminal" | "suppressSdkConsoleErrors" | "verbose",
  value: unknown,
): void {
  if (typeof value === "boolean") {
    options[key] = value;
  }
}

function assignFiniteNumberOption(
  options: QueueOwnerRuntimeOptions,
  key: "ttlMs",
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    options[key] = value;
  }
}

function assignRoundedNumberOption(
  options: QueueOwnerRuntimeOptions,
  key: "maxQueueDepth" | "promptRetries",
  value: unknown,
  min: number,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    options[key] = Math.max(min, Math.round(value));
  }
}

function assignQueueOwnerSessionOptions(
  options: QueueOwnerRuntimeOptions,
  rawSessionOptions: unknown,
): void {
  const sessionOpts = asRecord(rawSessionOptions);
  if (!sessionOpts) {
    return;
  }

  options.sessionOptions = {};
  assignSessionModel(options.sessionOptions, sessionOpts.model);
  assignSessionAllowedTools(options.sessionOptions, sessionOpts.allowedTools);
  assignSessionMaxTurns(options.sessionOptions, sessionOpts.maxTurns);
  assignSessionSystemPrompt(options.sessionOptions, sessionOpts.systemPrompt);
  assignSessionEnv(options.sessionOptions, sessionOpts.env);
}

function assignSessionModel(
  options: NonNullable<QueueOwnerRuntimeOptions["sessionOptions"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    options.model = value;
  }
}

function assignSessionAllowedTools(
  options: NonNullable<QueueOwnerRuntimeOptions["sessionOptions"]>,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    options.allowedTools = value.filter((tool): tool is string => typeof tool === "string");
  }
}

function assignSessionMaxTurns(
  options: NonNullable<QueueOwnerRuntimeOptions["sessionOptions"]>,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    options.maxTurns = Math.max(1, Math.round(value));
  }
}

function assignSessionSystemPrompt(
  options: NonNullable<QueueOwnerRuntimeOptions["sessionOptions"]>,
  value: unknown,
): void {
  if (typeof value === "string") {
    options.systemPrompt = value;
    return;
  }

  const systemPrompt = asRecord(value);
  if (typeof systemPrompt?.append === "string") {
    options.systemPrompt = { append: systemPrompt.append };
  }
}

function assignSessionEnv(
  options: NonNullable<QueueOwnerRuntimeOptions["sessionOptions"]>,
  value: unknown,
): void {
  const env = asRecord(value);
  if (!env) {
    return;
  }
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length > 0) {
    options.env = Object.fromEntries(entries);
  }
}

export async function runQueueOwnerFromEnv(env: NodeJS.ProcessEnv): Promise<void> {
  const payload = await readQueueOwnerPayloadFromEnv(env);
  const options = parseQueueOwnerPayload(payload);
  await runSessionQueueOwner(options);
}

async function readQueueOwnerPayloadFromEnv(env: NodeJS.ProcessEnv): Promise<string> {
  const payloadFile = env[QUEUE_OWNER_PAYLOAD_FILE_ENV];
  if (payloadFile) {
    const payload = await fs.readFile(payloadFile, "utf8");
    await cleanupQueueOwnerPayloadFile(payloadFile).catch(() => {
      // The payload is one-shot; startup should not fail only because cleanup lost a race.
    });
    return payload;
  }

  const payload = env[QUEUE_OWNER_PAYLOAD_ENV];
  if (!payload) {
    throw new Error(`missing ${QUEUE_OWNER_PAYLOAD_ENV}`);
  }
  return payload;
}

async function cleanupQueueOwnerPayloadFile(payloadFile: string): Promise<void> {
  if (!isQueueOwnerPayloadFile(payloadFile)) {
    return;
  }
  await fs.unlink(payloadFile).catch(() => {
    // Ignore a file already removed by a racing startup path.
  });
  await fs.rmdir(path.dirname(payloadFile)).catch(() => {
    // The private temp dir should be empty after unlink; leave it alone if it is not.
  });
}

function isQueueOwnerPayloadFile(payloadFile: string): boolean {
  const resolved = path.resolve(payloadFile);
  const payloadDir = path.dirname(resolved);
  return (
    path.dirname(payloadDir) === path.resolve(os.tmpdir()) &&
    path.basename(payloadDir).startsWith("acpx-queue-owner-") &&
    path.basename(resolved) === "payload.json"
  );
}
