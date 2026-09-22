import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../../errors.js";
import { incrementPerfCounter, measurePerf } from "../../perf-metrics.js";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import { writePrivateJsonFile } from "../../state-files.js";
import type { SessionRecord } from "../../types.js";
import { safeSessionId, sessionBaseDir } from "../event-log.js";
import { scanSessionRecords } from "./discovery.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";

export const DEFAULT_HISTORY_LIMIT = 20;

type FindSessionOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  includeClosed?: boolean;
  readOnly?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  boundary?: string;
};

function sessionFilePath(acpxRecordId: string): string {
  const safeId = safeSessionId(acpxRecordId);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true, mode: 0o700 });
}

async function* sessionRecords(readOnly = false): AsyncGenerator<SessionRecord> {
  if (!readOnly) {
    await ensureSessionDir();
  }
  yield* scanSessionRecords(sessionBaseDir());
}

function matchesSession(
  session: SessionRecord,
  agentCommand: string,
  normalizedName: string | undefined,
  includeClosed = false,
): boolean {
  if (session.agentCommand !== agentCommand) {
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

function isNewer(record: SessionRecord, previous: SessionRecord | undefined): boolean {
  return !previous || record.lastUsedAt.localeCompare(previous.lastUsedAt) > 0;
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await measurePerf("session.write_record", async () => {
    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const file = sessionFilePath(record.acpxRecordId);
    await writePrivateJsonFile(file, persisted);
  });
}

export async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  try {
    const directRecord = await measurePerf(
      "session.resolve_direct",
      async () => await readSessionRecord(sessionId),
    );
    if (directRecord?.acpxRecordId === sessionId) {
      return directRecord;
    }
  } catch {
    // Fall back to canonical discovery.
  }

  const { exactRecords, suffixRecords } = await findSessionIdMatches(sessionId);
  if (exactRecords.length === 1) {
    return exactRecords[0];
  }
  if (exactRecords.length > 1) {
    throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
  }

  if (suffixRecords.length === 1) {
    return suffixRecords[0];
  }
  if (suffixRecords.length > 1) {
    throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
  }

  incrementPerfCounter("session.resolve_miss");
  throw new SessionNotFoundError(sessionId);
}

async function findSessionIdMatches(
  sessionId: string,
): Promise<{ exactRecords: SessionRecord[]; suffixRecords: SessionRecord[] }> {
  const exactRecords: SessionRecord[] = [];
  const suffixRecords: SessionRecord[] = [];
  for await (const record of sessionRecords()) {
    if (record.acpxRecordId === sessionId || record.acpSessionId === sessionId) {
      retainMatch(exactRecords, record);
    }
    if (record.acpxRecordId.endsWith(sessionId) || record.acpSessionId.endsWith(sessionId)) {
      retainMatch(suffixRecords, record);
    }
  }
  return { exactRecords, suffixRecords };
}

function retainMatch(matches: SessionRecord[], record: SessionRecord): void {
  if (matches.length < 2) {
    matches.push(record);
  }
}

/** Reads one canonical record without creating directories or scanning other sessions. */
export async function readSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
  let payload: string;
  try {
    payload = await fs.readFile(sessionFilePath(sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const record = parseSessionRecord(JSON.parse(payload));
    return record?.acpxRecordId === sessionId ? record : undefined;
  } catch {
    return undefined;
  }
}

function hasGitMarker(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    const marker = statSync(gitPath);
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function isWithinBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function absolutePath(value: string): string {
  return path.resolve(value);
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = absolutePath(startDir);
  const root = path.parse(current).root;

  for (;;) {
    if (hasGitMarker(current)) {
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
  return await collectSessionRecords();
}

export async function listSessionsForAgent(agentCommand: string): Promise<SessionRecord[]> {
  return await collectSessionRecords(agentCommand);
}

async function collectSessionRecords(agentCommand?: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for await (const record of sessionRecords()) {
    if (agentCommand === undefined || record.agentCommand === agentCommand) {
      records.push(record);
    }
  }
  return records.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export async function findSession(options: FindSessionOptions): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  let match: SessionRecord | undefined;
  for await (const record of sessionRecords(options.readOnly)) {
    if (
      record.cwd === normalizedCwd &&
      matchesSession(record, options.agentCommand, normalizedName, options.includeClosed) &&
      isNewer(record, match)
    ) {
      match = record;
    }
  }
  return match;
}

export async function findSessionByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionRecord | undefined> {
  const normalizedName = normalizeName(options.name);
  const directories = walkDirectories(options);
  let match: SessionRecord | undefined;
  let distance = Infinity;
  for await (const record of sessionRecords()) {
    const candidateDistance = directories.get(record.cwd);
    if (
      candidateDistance !== undefined &&
      matchesSession(record, options.agentCommand, normalizedName) &&
      (candidateDistance < distance || (candidateDistance === distance && isNewer(record, match)))
    ) {
      match = record;
      distance = candidateDistance;
    }
  }
  return match;
}

function walkDirectories(options: FindSessionByDirectoryWalkOptions): Map<string, number> {
  const normalizedStart = absolutePath(options.cwd);
  const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
  const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart)
    ? normalizedBoundary
    : normalizedStart;
  const directories = new Map<string, number>();
  const walkRoot = path.parse(normalizedStart).root;
  let current: string | undefined = normalizedStart;
  while (current) {
    directories.set(current, directories.size);
    current = nextWalkParent(current, walkBoundary, walkRoot);
  }
  return directories;
}

function nextWalkParent(
  current: string,
  walkBoundary: string,
  walkRoot: string,
): string | undefined {
  if (current === walkBoundary || current === walkRoot) {
    return undefined;
  }

  const parent = path.dirname(current);
  if (parent === current || !isWithinBoundary(walkBoundary, parent)) {
    return undefined;
  }

  return parent;
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
  const segmentPrefix = `${safeId}.stream.`;
  return (
    fileName === `${safeId}.stream.ndjson` ||
    fileName === `${safeId}.stream.lock` ||
    (fileName.startsWith(segmentPrefix) &&
      /^\d+\.ndjson$/.test(fileName.slice(segmentPrefix.length)))
  );
}

export async function pruneSessions(options: PruneOptions = {}): Promise<PruneResult> {
  const cutoff =
    options.before ??
    (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : undefined);

  const records = await loadPrunableRecords(cutoff, options.agentCommand);

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
    bytesFreed += await pruneSessionFiles(
      record,
      sessionDir,
      dirEntries,
      options.includeHistory === true,
    );
  }

  return { pruned: records, bytesFreed, dryRun: false };
}

function isPruneCandidate(
  record: Pick<SessionRecord, "closed" | "agentCommand">,
  agentCommand: string | undefined,
): boolean {
  return record.closed === true && (!agentCommand || record.agentCommand === agentCommand);
}

async function loadPrunableRecords(
  cutoff: Date | undefined,
  agentCommand: string | undefined,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  const cutoffIso = cutoff?.toISOString();
  for await (const record of sessionRecords()) {
    if (isPruneCandidate(record, agentCommand) && isBeforeCutoff(record, cutoffIso)) {
      records.push(record);
    }
  }
  return records.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

function isBeforeCutoff(record: SessionRecord, cutoffIso: string | undefined): boolean {
  return !cutoffIso || closedAtOrLastUsedAt(record) < cutoffIso;
}

async function pruneSessionFiles(
  record: SessionRecord,
  sessionDir: string,
  dirEntries: string[],
  includeHistory: boolean,
): Promise<number> {
  const safeId = safeSessionId(record.acpxRecordId);
  let bytesFreed = await unlinkCountingBytes(path.join(sessionDir, `${safeId}.json`));
  if (includeHistory) {
    for (const name of dirEntries.filter((entry) => isSessionStreamFile(entry, safeId))) {
      bytesFreed += await unlinkCountingBytes(path.join(sessionDir, name));
    }
  }
  return bytesFreed;
}

async function unlinkCountingBytes(filePath: string): Promise<number> {
  let bytes = 0;
  try {
    const stat = await fs.stat(filePath);
    bytes = stat.size;
  } catch {
    // file already gone
  }
  await fs.unlink(filePath).catch(() => undefined);
  return bytes;
}
