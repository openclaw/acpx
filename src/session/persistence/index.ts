import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../../types.js";
import { parseSessionRecord } from "./parse.js";

const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";

export type SessionIndexEntry = {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  lastUsedAt: string;
};

type SessionIndex = {
  schema: typeof SESSION_INDEX_SCHEMA;
  files: string[];
  entries: SessionIndexEntry[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseIndexEntry(raw: unknown): SessionIndexEntry | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  if (
    typeof record.file !== "string" ||
    typeof record.acpxRecordId !== "string" ||
    typeof record.acpSessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    typeof record.closed !== "boolean"
  ) {
    return undefined;
  }
  if (record.name !== undefined && typeof record.name !== "string") {
    return undefined;
  }
  return {
    file: record.file,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed,
    lastUsedAt: record.lastUsedAt,
  };
}

export function sessionIndexPath(sessionDir: string): string {
  return path.join(sessionDir, "index.json");
}

export function toSessionIndexEntry(record: SessionRecord, fileName: string): SessionIndexEntry {
  return {
    file: fileName,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed === true,
    lastUsedAt: record.lastUsedAt,
  };
}

export async function readSessionIndex(sessionDir: string): Promise<SessionIndex | undefined> {
  const filePath = sessionIndexPath(sessionDir);
  try {
    const payload = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(payload) as unknown;
    const record = asRecord(parsed);
    if (!record || record.schema !== SESSION_INDEX_SCHEMA || !Array.isArray(record.files)) {
      return undefined;
    }
    const files = record.files.filter((entry): entry is string => typeof entry === "string");
    if (files.length !== record.files.length || !Array.isArray(record.entries)) {
      return undefined;
    }
    const entries = record.entries
      .map((entry) => parseIndexEntry(entry))
      .filter((entry): entry is SessionIndexEntry => Boolean(entry));
    if (entries.length !== record.entries.length) {
      return undefined;
    }
    return {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries,
    };
  } catch {
    return undefined;
  }
}

export async function writeSessionIndex(
  sessionDir: string,
  index: {
    files: string[];
    entries: SessionIndexEntry[];
  },
): Promise<void> {
  const filePath = sessionIndexPath(sessionDir);
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(
    {
      schema: SESSION_INDEX_SCHEMA,
      files: [...index.files].toSorted(),
      entries: [...index.entries].toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
    },
    null,
    2,
  );
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

export async function rebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();

  const indexEntries: SessionIndexEntry[] = [];
  for (const file of files) {
    try {
      const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
      const parsed = parseSessionRecord(JSON.parse(payload));
      if (!parsed) {
        continue;
      }
      indexEntries.push(toSessionIndexEntry(parsed, file));
    } catch {
      // ignore corrupt session files while rebuilding the cache index
    }
  }

  const index: SessionIndex = {
    schema: SESSION_INDEX_SCHEMA,
    files,
    entries: indexEntries,
  };
  await writeSessionIndex(sessionDir, index);
  return index;
}

export async function loadOrRebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  const files = (await fs.readdir(sessionDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();
  const existing = await readSessionIndex(sessionDir);
  if (
    existing &&
    existing.files.length === files.length &&
    existing.files.every((file, index) => file === files[index])
  ) {
    return existing;
  }
  return await rebuildSessionIndex(sessionDir);
}
