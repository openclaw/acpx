import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../../errors.js";
import { incrementPerfCounter, measurePerf } from "../../perf-metrics.js";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import type { SessionRecord } from "../../types.js";
import {
  loadOrRebuildSessionIndex,
  rebuildSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "./index.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";

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

async function loadRecordFromIndexEntry(
  entry: SessionIndexEntry,
): Promise<SessionRecord | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionBaseDir(), entry.file), "utf8");
    return parseSessionRecord(JSON.parse(payload)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function loadSessionIndexEntries(): Promise<SessionIndexEntry[]> {
  await ensureSessionDir();
  const index = await measurePerf("session.index_load", async () => {
    return await loadOrRebuildSessionIndex(sessionBaseDir());
  });
  return index.entries;
}

function matchesSessionEntry(
  session: SessionIndexEntry,
  normalizedCwd: string,
  normalizedName: string | undefined,
  includeClosed = false,
): boolean {
  if (session.cwd !== normalizedCwd) {
    return false;
  }
  if (!includeClosed && session.closed) {
    return false;
  }
  if (normalizedName == null) {
    return session.name == null;
  }
  return session.name === normalizedName;
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await measurePerf("session.write_record", async () => {
    await ensureSessionDir();

    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const file = sessionFilePath(record.acpxRecordId);
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(persisted, null, 2);
    await fs.writeFile(tempFile, `${payload}\n`, "utf8");
    await fs.rename(tempFile, file);

    const sessionDir = sessionBaseDir();
    const index = await loadOrRebuildSessionIndex(sessionDir);
    const fileName = path.basename(file);
    const entries = index.entries.filter((entry) => entry.file !== fileName);
    entries.push(toSessionIndexEntry(record, fileName));
    const files = [...new Set([...index.files.filter((entry) => entry !== fileName), fileName])];
    await writeSessionIndex(sessionDir, { files, entries });
  });
}

export async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  const directPath = sessionFilePath(sessionId);
  try {
    const directPayload = await measurePerf("session.resolve_direct", async () => {
      return await fs.readFile(directPath, "utf8");
    });
    const directRecord = parseSessionRecord(JSON.parse(directPayload));
    if (directRecord) {
      return directRecord;
    }
  } catch {
    // fallback to indexed search
  }

  const entries = await loadSessionIndexEntries();
  const exactEntries = entries.filter(
    (entry) => entry.acpxRecordId === sessionId || entry.acpSessionId === sessionId,
  );
  const exactRecords = (
    await Promise.all(exactEntries.map((entry) => loadRecordFromIndexEntry(entry)))
  ).filter((entry): entry is SessionRecord => Boolean(entry));
  if (exactRecords.length === 1) {
    return exactRecords[0];
  }
  if (exactRecords.length > 1) {
    throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixEntries = entries.filter(
    (entry) => entry.acpxRecordId.endsWith(sessionId) || entry.acpSessionId.endsWith(sessionId),
  );
  const suffixRecords = (
    await Promise.all(suffixEntries.map((entry) => loadRecordFromIndexEntry(entry)))
  ).filter((entry): entry is SessionRecord => Boolean(entry));
  if (suffixRecords.length === 1) {
    return suffixRecords[0];
  }
  if (suffixRecords.length > 1) {
    throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
  }

  incrementPerfCounter("session.resolve_miss");
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
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  const entries = await loadSessionIndexEntries();
  const records: SessionRecord[] = [];

  for (const entry of entries) {
    const parsed = await loadRecordFromIndexEntry(entry);
    if (parsed) {
      records.push(parsed);
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return records;
}

export async function listSessionsForAgent(agentCommand: string): Promise<SessionRecord[]> {
  const entries = (await loadSessionIndexEntries()).filter(
    (session) => session.agentCommand === agentCommand,
  );
  const records = await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)));
  return records
    .filter((entry): entry is SessionRecord => Boolean(entry))
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export async function findSession(options: FindSessionOptions): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const entries = await loadSessionIndexEntries();
  const match = entries.find(
    (session) =>
      session.agentCommand === options.agentCommand &&
      matchesSessionEntry(session, normalizedCwd, normalizedName, options.includeClosed),
  );
  if (!match) {
    return undefined;
  }
  return await loadRecordFromIndexEntry(match);
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
  const sessions = (await loadSessionIndexEntries()).filter(
    (session) => session.agentCommand === options.agentCommand,
  );

  let current = normalizedStart;
  const walkRoot = path.parse(current).root;

  for (;;) {
    const match = sessions.find((session) => matchesSessionEntry(session, current, normalizedName));
    if (match) {
      return await loadRecordFromIndexEntry(match);
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

export type PruneOptions = {
  agentCommand?: string;
  before?: Date;
  olderThanMs?: number;
  includeHistory?: boolean;
  dryRun?: boolean;
};

export type PruneResult = {
  pruned: SessionRecord[];
  bytesFreed: number;
  dryRun: boolean;
};

function closedAtOrLastUsedAt(record: SessionRecord): string {
  return record.closedAt ?? record.lastUsedAt;
}

function isSessionStreamFile(fileName: string, safeId: string): boolean {
  return (
    fileName === `${safeId}.stream.ndjson` ||
    fileName === `${safeId}.stream.lock` ||
    fileName.startsWith(`${safeId}.stream.`)
  );
}

export async function pruneSessions(options: PruneOptions = {}): Promise<PruneResult> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();

  let eligible = entries.filter((entry) => entry.closed);

  if (options.agentCommand) {
    eligible = eligible.filter((entry) => entry.agentCommand === options.agentCommand);
  }

  const cutoff =
    options.before ??
    (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : undefined);

  const records: SessionRecord[] = [];
  for (const entry of eligible) {
    const record = await loadRecordFromIndexEntry(entry);
    if (record && (!cutoff || closedAtOrLastUsedAt(record) < cutoff.toISOString())) {
      records.push(record);
    }
  }

  if (options.dryRun) {
    return { pruned: records, bytesFreed: 0, dryRun: true };
  }

  const sessionDir = sessionBaseDir();
  let bytesFreed = 0;

  // Read the directory once upfront so stream-file matching doesn't re-read
  // it for every session in the loop.
  let dirEntries: string[] = [];
  if (options.includeHistory) {
    try {
      dirEntries = await fs.readdir(sessionDir);
    } catch {
      // ignore
    }
  }

  for (const record of records) {
    const safeId = encodeURIComponent(record.acpxRecordId);
    const jsonFile = path.join(sessionDir, `${safeId}.json`);

    try {
      const stat = await fs.stat(jsonFile);
      bytesFreed += stat.size;
    } catch {
      // file already gone
    }
    await fs.unlink(jsonFile).catch(() => undefined);

    if (options.includeHistory) {
      for (const name of dirEntries) {
        if (!isSessionStreamFile(name, safeId)) {
          continue;
        }
        const filePath = path.join(sessionDir, name);
        try {
          const stat = await fs.stat(filePath);
          bytesFreed += stat.size;
        } catch {
          // ignore
        }
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
  }

  await rebuildSessionIndex(sessionDir).catch(() => {
    // best effort cache rebuild
  });

  return { pruned: records, bytesFreed, dryRun: false };
}

export async function closeSession(id: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(id);
  const now = isoNow();

  if (record.pid) {
    for (const signal of killSignalCandidates(record.lastAgentExitSignal ?? undefined)) {
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
  await rebuildSessionIndex(sessionBaseDir()).catch(() => {
    // best effort cache rebuild
  });
  return record;
}
