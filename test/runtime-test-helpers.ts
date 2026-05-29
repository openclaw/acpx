import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionStore } from "../src/runtime.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

export type MakeSessionRecordOptions = {
  defaultName?: boolean;
  defaultAcpx?: boolean;
  resolveCwd?: boolean;
};

export function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
  options: MakeSessionRecordOptions = {},
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const defaultName = options.defaultName ?? true;
  const defaultAcpx = options.defaultAcpx ?? true;
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: options.resolveCwd === false ? overrides.cwd : path.resolve(overrides.cwd),
    name: overrides.name ?? (defaultName ? overrides.acpxRecordId : undefined),
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    cumulative_cost: overrides.cumulative_cost,
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx ?? (defaultAcpx ? {} : undefined),
    importedFrom: overrides.importedFrom,
  };
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function withTempHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T>,
): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.HOME = tempHome;

  try {
    return await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

export function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

export async function writeSessionRecordFile(
  homeDir: string,
  record: SessionRecord,
): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class InMemorySessionStore implements AcpSessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly savedRecordIds: string[] = [];

  constructor(initialRecords: SessionRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.acpxRecordId, structuredClone(record));
    }
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : undefined;
  }

  async save(record: SessionRecord): Promise<void> {
    this.savedRecordIds.push(record.acpxRecordId);
    this.records.set(record.acpxRecordId, structuredClone(record));
  }
}

export function createRuntimeOptions(params: {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry?: AcpAgentRegistry;
  timeoutMs?: number;
}): AcpRuntimeOptions {
  return {
    cwd: params.cwd,
    sessionStore: params.sessionStore,
    timeoutMs: params.timeoutMs,
    agentRegistry: params.agentRegistry ?? {
      resolve(agentName: string) {
        return `${agentName} --acp`;
      },
      list() {
        return ["codex"];
      },
    },
    permissionMode: "approve-reads",
  };
}
