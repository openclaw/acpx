import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../../agent-registry.js";
import type { SessionRecord } from "../../types.js";
import { exportSession } from "../export.js";
import { importSession } from "../import.js";
import { resolveSessionRecord, serializeSessionRecordForDisk } from "../persistence.js";

function makeSessionRecord(
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
    importedFrom: overrides.importedFrom,
  };
}

async function withTempHome<T>(prefix: string, run: (homeDir: string) => Promise<T>): Promise<T> {
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

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

async function writeSessionRecordFile(homeDir: string, record: SessionRecord): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

function streamPath(homeDir: string, recordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(recordId)}.stream.ndjson`);
}

async function writeHistory(homeDir: string, recordId: string, entries: unknown[]): Promise<void> {
  const filePath = streamPath(homeDir, recordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

async function readHistory(homeDir: string, recordId: string): Promise<unknown[]> {
  const payload = await fs.readFile(streamPath(homeDir, recordId), "utf8");
  return payload
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

test("exportSession and importSession round-trip session state with a fresh record id", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    const source = makeSessionRecord({
      acpxRecordId: "source-record",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "debug",
      messages: [
        {
          User: {
            id: "user-1",
            content: [{ Text: "hello" }],
          },
        },
      ],
    });
    await writeSessionRecordFile(homeDir, source);

    const history = [
      { jsonrpc: "2.0", method: "session/update", params: { text: "one" } },
      { jsonrpc: "2.0", method: "session/update", params: { text: "two" } },
    ];
    await writeHistory(homeDir, source.acpxRecordId, history);

    await exportSession(
      {
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
      },
      archivePath,
    );

    await fs.rm(sessionFilePath(homeDir, source.acpxRecordId));
    await fs.rm(streamPath(homeDir, source.acpxRecordId));

    const imported = await importSession(archivePath);
    const record = await resolveSessionRecord(imported.record_id);

    assert.notEqual(record.acpxRecordId, source.acpxRecordId);
    assert.equal(record.acpSessionId, source.acpSessionId);
    assert.equal(record.agentCommand, source.agentCommand);
    assert.equal(record.name, source.name);
    assert.equal(record.cwd, source.cwd);
    assert.deepEqual(record.messages, source.messages);
    assert.deepEqual(await readHistory(homeDir, imported.record_id), history);
    assert.deepEqual(record.importedFrom, {
      recordId: source.acpxRecordId,
      cwdOriginal: source.cwd,
      exportedBy: record.importedFrom?.exportedBy,
      exportedAt: record.importedFrom?.exportedAt,
    });
  });
});

test("importSession rewrites cwd and name when requested", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const newCwd = path.join(homeDir, "other");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "source-record",
        acpSessionId: "provider-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
      }),
    );

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const imported = await importSession(archivePath, {
      name: "debug-on-laptop",
      newCwd,
    });
    const record = await resolveSessionRecord(imported.record_id);

    assert.equal(imported.cwd, newCwd);
    assert.equal(record.cwd, newCwd);
    assert.equal(record.name, "debug-on-laptop");
  });
});

test("exportSession refuses a session locked by a live pid", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const recordId = "locked-record";
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: recordId,
        acpSessionId: recordId,
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
      }),
    );
    const lockPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(recordId)}.stream.lock`,
    );
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );

    await assert.rejects(
      exportSession(
        { agentCommand: AGENT_REGISTRY.codex, cwd, name: recordId },
        path.join(homeDir, "archive.json"),
      ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "session-locked");
        assert.equal((error as { exitCode?: unknown }).exitCode, 2);
        return true;
      },
    );
  });
});

test("importSession rejects unsupported archive format versions", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const archivePath = path.join(homeDir, "bad.json");
    await fs.writeFile(archivePath, `${JSON.stringify({ format_version: 2 })}\n`, "utf8");

    await assert.rejects(
      importSession(archivePath),
      /Unsupported session export format_version 2; supported version is 1/,
    );
  });
});

test("importSession generates a new record id when the source still exists locally", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    const source = makeSessionRecord({
      acpxRecordId: "source-record",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "debug",
    });
    await writeSessionRecordFile(homeDir, source);
    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const imported = await importSession(archivePath);

    assert.notEqual(imported.record_id, source.acpxRecordId);
    assert.ok(await fs.stat(sessionFilePath(homeDir, source.acpxRecordId)));
    assert.ok(await fs.stat(sessionFilePath(homeDir, imported.record_id)));
  });
});
