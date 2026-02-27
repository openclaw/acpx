import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "./errors.js";
import { normalizeRuntimeSessionId } from "./runtime-session-id.js";
import { createSessionThread } from "./session-thread-model.js";
import type { SessionAcpxState, SessionRecord, SessionThread } from "./types.js";
import { SESSION_RECORD_SCHEMA } from "./types.js";

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

function sessionFilePath(acpxRecordId: string): string {
  const safeId = encodeURIComponent(acpxRecordId);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

function sessionBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "sessions");
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

function parseThreadMessage(
  raw: unknown,
): SessionThread["messages"][number] | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.kind !== "string") {
    return undefined;
  }

  if (record.kind === "resume") {
    return { kind: "resume" };
  }

  if (record.kind === "user") {
    if (typeof record.id !== "string" || !Array.isArray(record.content)) {
      return undefined;
    }

    const content = record.content.filter((entry) => {
      const item = asRecord(entry);
      if (!item || typeof item.type !== "string") {
        return false;
      }

      if (item.type === "text") {
        return typeof item.text === "string";
      }
      if (item.type === "mention") {
        return typeof item.uri === "string" && typeof item.content === "string";
      }
      if (item.type === "image") {
        return true;
      }

      return false;
    });

    return {
      kind: "user",
      id: record.id,
      content: content as SessionThread["messages"][number] extends infer T
        ? T extends { kind: "user"; content: infer C }
          ? C
          : never
        : never,
    };
  }

  if (record.kind === "agent") {
    if (!Array.isArray(record.content)) {
      return undefined;
    }

    const content = record.content.filter((entry) => {
      const item = asRecord(entry);
      if (!item || typeof item.type !== "string") {
        return false;
      }

      switch (item.type) {
        case "text":
          return typeof item.text === "string";
        case "thinking":
          return typeof item.text === "string";
        case "redacted_thinking":
          return true;
        case "tool_use":
          return typeof item.id === "string" && typeof item.name === "string";
        default:
          return false;
      }
    });

    return {
      kind: "agent",
      content: content as SessionThread["messages"][number] extends infer T
        ? T extends { kind: "agent"; content: infer C }
          ? C
          : never
        : never,
      tool_results: asRecord(
        record.tool_results,
      ) as SessionThread["messages"][number] extends infer T
        ? T extends { kind: "agent"; tool_results?: infer R }
          ? R
          : never
        : never,
      reasoning_details: record.reasoning_details,
    };
  }

  return undefined;
}

function parseThread(
  raw: unknown,
  fallbackTimestamp: string,
): SessionThread | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const messages = Array.isArray(record.messages)
    ? record.messages
        .map((entry) => parseThreadMessage(entry))
        .filter((entry): entry is SessionThread["messages"][number] => !!entry)
    : [];

  const thread = createSessionThread(
    typeof record.updated_at === "string" ? record.updated_at : fallbackTimestamp,
  );

  thread.version = "0.3.0";
  thread.title =
    record.title === null
      ? null
      : typeof record.title === "string"
        ? record.title
        : null;
  thread.messages = messages;
  thread.updated_at =
    typeof record.updated_at === "string" ? record.updated_at : fallbackTimestamp;
  thread.detailed_summary =
    record.detailed_summary === null || typeof record.detailed_summary === "string"
      ? (record.detailed_summary as string | null | undefined)
      : null;
  thread.initial_project_snapshot =
    record.initial_project_snapshot === undefined
      ? null
      : record.initial_project_snapshot;
  thread.cumulative_token_usage = asRecord(record.cumulative_token_usage) ?? {};
  thread.request_token_usage = asRecord(record.request_token_usage) ?? {};
  thread.model =
    record.model === null || typeof record.model === "string"
      ? (record.model as string | null | undefined)
      : null;
  thread.profile =
    record.profile === null || typeof record.profile === "string"
      ? (record.profile as string | null | undefined)
      : null;
  thread.imported = record.imported === true;
  thread.subagent_context =
    record.subagent_context === undefined ? null : record.subagent_context;
  thread.speed =
    record.speed === null || typeof record.speed === "string"
      ? (record.speed as string | null | undefined)
      : null;
  thread.thinking_enabled = record.thinking_enabled === true;
  thread.thinking_effort =
    record.thinking_effort === null || typeof record.thinking_effort === "string"
      ? (record.thinking_effort as string | null | undefined)
      : null;

  return thread;
}

function parseAcpxState(raw: unknown): SessionAcpxState | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const state: SessionAcpxState = {};

  if (typeof record.current_mode_id === "string") {
    state.current_mode_id = record.current_mode_id;
  }

  if (isStringArray(record.available_commands)) {
    state.available_commands = [...record.available_commands];
  }

  if (Array.isArray(record.config_options)) {
    state.config_options = record.config_options as SessionAcpxState["config_options"];
  }

  if (Array.isArray(record.audit_events)) {
    state.audit_events = record.audit_events.filter((entry) => {
      const audit = asRecord(entry);
      return (
        !!audit && typeof audit.type === "string" && typeof audit.timestamp === "string"
      );
    }) as SessionAcpxState["audit_events"];
  }

  return state;
}

function normalizeOptionalName(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalPid(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) <= 0) {
    return null;
  }

  return value as number;
}

function normalizeOptionalBoolean(value: unknown, fallback = false): boolean | null {
  if (value == null) {
    return fallback;
  }
  return typeof value === "boolean" ? value : null;
}

function normalizeOptionalString(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function normalizeOptionalExitCode(value: unknown): number | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (Number.isInteger(value)) {
    return value as number;
  }
  return Symbol("invalid");
}

function normalizeOptionalSignal(
  value: unknown,
): NodeJS.Signals | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value as NodeJS.Signals;
  }
  return Symbol("invalid");
}

function parseSessionRecord(raw: unknown): SessionRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  if (record.schema !== SESSION_RECORD_SCHEMA) {
    return null;
  }

  const name = normalizeOptionalName(record.name);
  const pid = normalizeOptionalPid(record.pid);
  const closed = normalizeOptionalBoolean(record.closed, false);
  const closedAt = normalizeOptionalString(record.closedAt);
  const agentStartedAt = normalizeOptionalString(record.agentStartedAt);
  const lastPromptAt = normalizeOptionalString(record.lastPromptAt);
  const lastAgentExitCode = normalizeOptionalExitCode(record.lastAgentExitCode);
  const lastAgentExitSignal = normalizeOptionalSignal(record.lastAgentExitSignal);
  const lastAgentExitAt = normalizeOptionalString(record.lastAgentExitAt);
  const lastAgentDisconnectReason = normalizeOptionalString(
    record.lastAgentDisconnectReason,
  );

  if (
    typeof record.acpxRecordId !== "string" ||
    typeof record.acpSessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    name === null ||
    pid === null ||
    closed === null ||
    closedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null
  ) {
    return null;
  }

  const thread =
    parseThread(record.thread, record.lastUsedAt) ??
    createSessionThread(record.lastUsedAt);

  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentSessionId: normalizeRuntimeSessionId(record.agentSessionId),
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
    protocolVersion:
      typeof record.protocolVersion === "number" ? record.protocolVersion : undefined,
    agentCapabilities: asRecord(
      record.agentCapabilities,
    ) as SessionRecord["agentCapabilities"],
    thread,
    acpx: parseAcpxState(record.acpx),
  };
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionDir();
  const canonical: SessionRecord = {
    ...record,
    schema: SESSION_RECORD_SCHEMA,
  };

  const file = sessionFilePath(canonical.acpxRecordId);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(canonical, null, 2);
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
    (session) =>
      session.acpxRecordId === sessionId || session.acpSessionId === sessionId,
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixMatches = sessions.filter(
    (session) =>
      session.acpxRecordId.endsWith(sessionId) ||
      session.acpSessionId.endsWith(sessionId),
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
