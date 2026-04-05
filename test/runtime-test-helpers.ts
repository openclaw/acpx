import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionStore } from "../src/runtime.js";
import type { SessionRecord } from "../src/types.js";

export function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name ?? overrides.acpxRecordId,
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
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx ?? {},
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
}): AcpRuntimeOptions {
  return {
    cwd: params.cwd,
    sessionStore: params.sessionStore,
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
