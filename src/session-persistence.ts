import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "./errors.js";
import { normalizeRuntimeSessionId } from "./runtime-session-id.js";
import {
  SESSION_ACP_PROJECTION_SCHEMA,
  type ClientOperation,
  type SessionAcpEvent,
  type SessionAcpPlanEntry,
  type SessionAcpProjection,
  type SessionAcpToolCall,
  type SessionHistoryEntry,
  type SessionRecord,
} from "./types.js";

export const DEFAULT_HISTORY_LIMIT = 20;

type FindSessionOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  includeClosed?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  boundary?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sessionFilePath(id: string): string {
  const safeId = encodeURIComponent(id);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

function sessionBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "sessions");
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

function parseHistoryEntries(raw: unknown): SessionHistoryEntry[] | undefined | null {
  if (raw == null) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    return null;
  }

  const entries: SessionHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const role = (item as { role?: unknown }).role;
    const timestamp = (item as { timestamp?: unknown }).timestamp;
    const textPreview = (item as { textPreview?: unknown }).textPreview;

    if (
      (role !== "user" && role !== "assistant") ||
      typeof timestamp !== "string" ||
      typeof textPreview !== "string"
    ) {
      return null;
    }

    entries.push({
      role,
      timestamp,
      textPreview,
    });
  }

  return entries;
}

function parseClientOperation(raw: unknown): ClientOperation | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const method = record.method;
  const status = record.status;
  const summary = record.summary;
  const timestamp = record.timestamp;
  const details = record.details;

  if (
    typeof method !== "string" ||
    typeof status !== "string" ||
    typeof summary !== "string" ||
    typeof timestamp !== "string"
  ) {
    return undefined;
  }

  return {
    method: method as ClientOperation["method"],
    status: status as ClientOperation["status"],
    summary,
    details: typeof details === "string" ? details : undefined,
    timestamp,
  };
}

function parseSessionAcpEvent(raw: unknown): SessionAcpEvent | undefined {
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.type !== "string" ||
    typeof record.timestamp !== "string"
  ) {
    return undefined;
  }

  if (record.type === "session_update") {
    const update = asRecord(record.update);
    if (!update || typeof update.sessionUpdate !== "string") {
      return undefined;
    }

    const metaRaw = record._meta;
    const meta =
      metaRaw === undefined
        ? undefined
        : metaRaw === null
          ? null
          : (asRecord(metaRaw) ?? undefined);

    return {
      type: "session_update",
      timestamp: record.timestamp,
      update: update as Extract<SessionAcpEvent, { type: "session_update" }>["update"],
      _meta: meta,
    };
  }

  if (record.type === "client_operation") {
    const operation = parseClientOperation(record.operation);
    if (!operation) {
      return undefined;
    }

    return {
      type: "client_operation",
      timestamp: record.timestamp,
      operation,
    };
  }

  return undefined;
}

function parseToolCall(raw: unknown): SessionAcpToolCall | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  if (typeof record.toolCallId !== "string" || typeof record.updatedAt !== "string") {
    return undefined;
  }

  return {
    toolCallId: record.toolCallId,
    title: typeof record.title === "string" ? record.title : undefined,
    status:
      typeof record.status === "string"
        ? (record.status as SessionAcpToolCall["status"])
        : undefined,
    kind:
      typeof record.kind === "string"
        ? (record.kind as SessionAcpToolCall["kind"])
        : undefined,
    locations: Array.isArray(record.locations)
      ? (record.locations as SessionAcpToolCall["locations"])
      : undefined,
    content: Array.isArray(record.content)
      ? (record.content as SessionAcpToolCall["content"])
      : undefined,
    rawInput: record.rawInput,
    rawOutput: record.rawOutput,
    updatedAt: record.updatedAt,
  };
}

function parsePlanEntries(raw: unknown): SessionAcpPlanEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const entries: SessionAcpPlanEntry[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    if (
      typeof record.content !== "string" ||
      typeof record.status !== "string" ||
      typeof record.priority !== "string"
    ) {
      continue;
    }

    entries.push({
      content: record.content,
      status: record.status as SessionAcpPlanEntry["status"],
      priority: record.priority as SessionAcpPlanEntry["priority"],
    });
  }

  return entries;
}

function parseConfigOptions(raw: unknown): SessionAcpProjection["configOptions"] {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const options = raw.filter((entry) => {
    const record = asRecord(entry);
    return (
      !!record &&
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      typeof record.currentValue === "string" &&
      Array.isArray(record.options)
    );
  });

  if (options.length === 0) {
    return undefined;
  }

  return options as SessionAcpProjection["configOptions"];
}

function parseUsage(raw: unknown): SessionAcpProjection["usage"] {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  if (typeof record.used !== "number" || typeof record.size !== "number") {
    return undefined;
  }

  const usage: NonNullable<SessionAcpProjection["usage"]> = {
    used: record.used,
    size: record.size,
  };

  if (typeof record.costAmount === "number") {
    usage.costAmount = record.costAmount;
  }
  if (typeof record.costCurrency === "string") {
    usage.costCurrency = record.costCurrency;
  }

  return usage;
}

function parseAcpProjection(raw: unknown): SessionAcpProjection | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const events: SessionAcpEvent[] = [];
  if (Array.isArray(record.events)) {
    for (const event of record.events) {
      const parsed = parseSessionAcpEvent(event);
      if (parsed) {
        events.push(parsed);
      }
    }
  }

  const toolCalls: SessionAcpToolCall[] = [];
  if (Array.isArray(record.toolCalls)) {
    for (const call of record.toolCalls) {
      const parsed = parseToolCall(call);
      if (parsed) {
        toolCalls.push(parsed);
      }
    }
  }

  return {
    schema:
      record.schema === SESSION_ACP_PROJECTION_SCHEMA
        ? SESSION_ACP_PROJECTION_SCHEMA
        : SESSION_ACP_PROJECTION_SCHEMA,
    events,
    toolCalls,
    plan: parsePlanEntries(record.plan),
    availableCommands: isStringArray(record.availableCommands)
      ? [...record.availableCommands]
      : undefined,
    currentModeId:
      typeof record.currentModeId === "string" ? record.currentModeId : undefined,
    configOptions: parseConfigOptions(record.configOptions),
    sessionTitle:
      record.sessionTitle === null
        ? null
        : typeof record.sessionTitle === "string"
          ? record.sessionTitle
          : undefined,
    sessionUpdatedAt:
      record.sessionUpdatedAt === null
        ? null
        : typeof record.sessionUpdatedAt === "string"
          ? record.sessionUpdatedAt
          : undefined,
    usage: parseUsage(record.usage),
  };
}

function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Partial<SessionRecord>;
  const runtimeSessionId = normalizeRuntimeSessionId(record.runtimeSessionId);
  const name =
    record.name == null
      ? undefined
      : typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : null;
  const pid =
    record.pid == null
      ? undefined
      : Number.isInteger(record.pid) && record.pid > 0
        ? record.pid
        : null;
  const closed =
    record.closed == null
      ? false
      : typeof record.closed === "boolean"
        ? record.closed
        : null;
  const closedAt =
    record.closedAt == null
      ? undefined
      : typeof record.closedAt === "string"
        ? record.closedAt
        : null;
  const agentStartedAt =
    record.agentStartedAt == null
      ? undefined
      : typeof record.agentStartedAt === "string"
        ? record.agentStartedAt
        : null;
  const lastPromptAt =
    record.lastPromptAt == null
      ? undefined
      : typeof record.lastPromptAt === "string"
        ? record.lastPromptAt
        : null;
  const rawLastAgentExitCode = (record as { lastAgentExitCode?: unknown })
    .lastAgentExitCode;
  const lastAgentExitCode =
    rawLastAgentExitCode === undefined
      ? undefined
      : rawLastAgentExitCode === null
        ? null
        : Number.isInteger(rawLastAgentExitCode)
          ? (rawLastAgentExitCode as number)
          : Symbol("invalid");
  const rawLastAgentExitSignal = (record as { lastAgentExitSignal?: unknown })
    .lastAgentExitSignal;
  const lastAgentExitSignal =
    rawLastAgentExitSignal === undefined
      ? undefined
      : rawLastAgentExitSignal === null
        ? null
        : typeof rawLastAgentExitSignal === "string"
          ? rawLastAgentExitSignal
          : Symbol("invalid");
  const lastAgentExitAt =
    record.lastAgentExitAt == null
      ? undefined
      : typeof record.lastAgentExitAt === "string"
        ? record.lastAgentExitAt
        : null;
  const lastAgentDisconnectReason =
    record.lastAgentDisconnectReason == null
      ? undefined
      : typeof record.lastAgentDisconnectReason === "string"
        ? record.lastAgentDisconnectReason
        : null;
  const turnHistory = parseHistoryEntries(
    (record as { turnHistory?: unknown }).turnHistory,
  );
  const acpProjection = parseAcpProjection(
    (record as { acpProjection?: unknown }).acpProjection,
  );

  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    name === null ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    pid === null ||
    closed === null ||
    closedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null ||
    turnHistory === null
  ) {
    return null;
  }

  return {
    ...record,
    id: record.id,
    sessionId: record.sessionId,
    runtimeSessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    closed,
    closedAt,
    pid,
    agentStartedAt,
    lastPromptAt,
    lastAgentExitCode,
    lastAgentExitSignal:
      lastAgentExitSignal == null
        ? lastAgentExitSignal
        : (lastAgentExitSignal as NodeJS.Signals),
    lastAgentExitAt,
    lastAgentDisconnectReason,
    turnHistory,
    acpProjection,
  };
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionDir();
  const file = sessionFilePath(record.id);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(record, null, 2);
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, file);
}

export async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  const directPath = sessionFilePath(sessionId);
  try {
    const directPayload = await fs.readFile(directPath, "utf8");
    const directRecord = parseSessionRecord(JSON.parse(directPayload));
    if (directRecord) {
      return directRecord;
    }
  } catch {
    // fallback to search
  }

  const sessions = await listSessions();

  const exact = sessions.filter(
    (session) => session.id === sessionId || session.sessionId === sessionId,
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixMatches = sessions.filter(
    (session) =>
      session.id.endsWith(sessionId) || session.sessionId.endsWith(sessionId),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
  }

  throw new SessionNotFoundError(sessionId);
}

function hasGitDirectory(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    return statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function isWithinBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function absolutePath(value: string): string {
  return path.resolve(value);
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = absolutePath(startDir);
  const root = path.parse(current).root;

  for (;;) {
    if (hasGitDirectory(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function normalizeName(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureSessionDir();

  const entries = await fs.readdir(sessionBaseDir(), { withFileTypes: true });
  const records: SessionRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const fullPath = path.join(sessionBaseDir(), entry.name);
    try {
      const payload = await fs.readFile(fullPath, "utf8");
      const parsed = parseSessionRecord(JSON.parse(payload));
      if (parsed) {
        records.push(parsed);
      }
    } catch {
      // ignore corrupt session files
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return records;
}

export async function listSessionsForAgent(
  agentCommand: string,
): Promise<SessionRecord[]> {
  const sessions = await listSessions();
  return sessions.filter((session) => session.agentCommand === agentCommand);
}

export async function findSession(
  options: FindSessionOptions,
): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const sessions = await listSessionsForAgent(options.agentCommand);

  return sessions.find((session) => {
    if (session.cwd !== normalizedCwd) {
      return false;
    }

    if (!options.includeClosed && session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  });
}

export async function findSessionByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionRecord | undefined> {
  const normalizedName = normalizeName(options.name);
  const normalizedStart = absolutePath(options.cwd);
  const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
  const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart)
    ? normalizedBoundary
    : normalizedStart;
  const sessions = await listSessionsForAgent(options.agentCommand);

  const matchesScope = (session: SessionRecord, dir: string): boolean => {
    if (session.cwd !== dir) {
      return false;
    }

    if (session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  };

  let current = normalizedStart;
  const walkRoot = path.parse(current).root;

  for (;;) {
    const match = sessions.find((session) => matchesScope(session, current));
    if (match) {
      return match;
    }

    if (current === walkBoundary || current === walkRoot) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;

    if (!isWithinBoundary(walkBoundary, current)) {
      return undefined;
    }
  }
}

function killSignalCandidates(signal: NodeJS.Signals | undefined): NodeJS.Signals[] {
  if (!signal) {
    return ["SIGTERM", "SIGKILL"];
  }

  const normalized = signal.toUpperCase() as NodeJS.Signals;
  if (normalized === "SIGKILL") {
    return ["SIGKILL"];
  }

  return [normalized, "SIGKILL"];
}

export async function closeSession(id: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(id);
  const now = isoNow();

  if (record.pid) {
    for (const signal of killSignalCandidates(
      record.lastAgentExitSignal ?? undefined,
    )) {
      try {
        process.kill(record.pid, signal);
      } catch {
        // ignore
      }
    }
  }

  record.closed = true;
  record.closedAt = now;
  record.pid = undefined;
  record.lastUsedAt = now;
  record.lastPromptAt = record.lastPromptAt ?? now;

  await writeSessionRecord(record);
  return record;
}
