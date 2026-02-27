import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../errors.js";
import { assertPersistedKeyPolicy } from "../persisted-key-policy.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";
import type { SessionRecord } from "../types.js";

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
export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionDir();

  const persisted = serializeSessionRecordForDisk(record);
  assertPersistedKeyPolicy(persisted);

  const file = sessionFilePath(record.acpxRecordId);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(persisted, null, 2);
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
