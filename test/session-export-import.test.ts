import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { exportSession } from "../src/session/export.js";
import { importSession } from "../src/session/import.js";
import { resolveSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

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

async function writeRawHistory(homeDir: string, recordId: string, payload: string): Promise<void> {
  const filePath = streamPath(homeDir, recordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
}

async function readHistory(homeDir: string, recordId: string): Promise<unknown[]> {
  const payload = await fs.readFile(streamPath(homeDir, recordId), "utf8");
  return payload
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      cwdOriginal: "workspace",
      exportedBy: record.importedFrom?.exportedBy,
      exportedAt: record.importedFrom?.exportedAt,
    });
  });
});

test("exportSession scrubs source absolute paths from portable archives", async () => {
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
      eventLog: {
        active_path: streamPath(homeDir, "source-record"),
        segment_count: 1,
        max_segment_bytes: 1024,
        max_segments: 1,
        last_write_at: "2026-01-01T00:00:00.000Z",
        last_write_error: null,
      },
    });
    await writeSessionRecordFile(homeDir, source);

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const payload = await fs.readFile(archivePath, "utf8");
    assert.doesNotMatch(payload, new RegExp(escapeRegExp(homeDir)));

    const archive = JSON.parse(payload) as {
      exported_by?: unknown;
      session?: {
        cwd_relative?: unknown;
        cwd_original?: unknown;
        cwd_absolute_original?: unknown;
        state?: {
          cwd?: unknown;
          event_log?: { active_path?: unknown };
        };
      };
    };
    assert.equal(archive.exported_by, "acpx");
    assert.equal(archive.session?.cwd_relative, "workspace");
    assert.equal(archive.session?.cwd_original, "workspace");
    assert.equal(archive.session?.cwd_absolute_original, undefined);
    assert.equal(archive.session?.state?.cwd, "workspace");
    assert.equal(archive.session?.state?.event_log?.active_path, ".stream.ndjson");
  });
});

test("exportSession skips malformed event-log lines", async () => {
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

    const validOne = { jsonrpc: "2.0", method: "session/update", params: { text: "one" } };
    const validTwo = { jsonrpc: "2.0", method: "session/update", params: { text: "two" } };
    await writeRawHistory(
      homeDir,
      source.acpxRecordId,
      [
        JSON.stringify(validOne),
        "{",
        JSON.stringify({ jsonrpc: "2.0", nope: true }),
        JSON.stringify(validTwo),
      ].join("\n"),
    );

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      history?: unknown[];
    };
    assert.deepEqual(archive.history, [validOne, validTwo]);
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
    await fs.rm(sessionFilePath(homeDir, "source-record"));

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

test("exportSession stores the home directory as a portable relative cwd", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const archivePath = path.join(homeDir, "archive.json");
    const source = makeSessionRecord({
      acpxRecordId: "home-record",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: homeDir,
      name: "home",
    });
    await writeSessionRecordFile(homeDir, source);

    await exportSession(
      { agentCommand: AGENT_REGISTRY.codex, cwd: homeDir, name: "home" },
      archivePath,
    );
    await fs.rm(sessionFilePath(homeDir, source.acpxRecordId));

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { cwd_relative?: unknown };
    };
    assert.equal(archive.session?.cwd_relative, ".");

    const imported = await importSession(archivePath, { name: "home-copy" });
    const record = await resolveSessionRecord(imported.record_id);

    assert.equal(record.cwd, homeDir);
  });
});

test("exportSession prefers an active session over an older closed record for the same scope", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "aaa-closed-record",
        acpSessionId: "closed-provider-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
        closed: true,
        closedAt: "2026-01-01T00:05:00.000Z",
        lastUsedAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "zzz-active-record",
        acpSessionId: "active-provider-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
        closed: false,
        lastUsedAt: "2026-01-01T00:10:00.000Z",
      }),
    );

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { record_id?: unknown };
    };
    assert.equal(archive.session?.record_id, "zzz-active-record");
  });
});

test("exportSession falls back to the newest closed session for a scope", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "aaa-closed-record",
        acpSessionId: "old-provider-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
        closed: true,
        closedAt: "2026-01-01T00:05:00.000Z",
        lastUsedAt: "2026-01-01T00:05:00.000Z",
      }),
    );
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "zzz-closed-record",
        acpSessionId: "new-provider-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        name: "debug",
        closed: true,
        closedAt: "2026-01-01T00:10:00.000Z",
        lastUsedAt: "2026-01-01T00:10:00.000Z",
      }),
    );

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { record_id?: unknown };
    };
    assert.equal(archive.session?.record_id, "zzz-closed-record");
  });
});

test("importSession reopens closed exported sessions without stale process metadata", async () => {
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
      closed: true,
      closedAt: "2026-01-02T00:00:00.000Z",
      pid: 12345,
      agentStartedAt: "2026-01-01T00:00:00.000Z",
      lastAgentExitCode: 0,
      lastAgentExitAt: "2026-01-02T00:00:00.000Z",
      lastAgentDisconnectReason: "closed",
    });
    await writeSessionRecordFile(homeDir, source);

    await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" }, archivePath);
    await fs.rm(sessionFilePath(homeDir, source.acpxRecordId));

    const imported = await importSession(archivePath);
    const record = await resolveSessionRecord(imported.record_id);

    assert.equal(record.closed, false);
    assert.equal(record.closedAt, undefined);
    assert.equal(record.pid, undefined);
    assert.equal(record.agentStartedAt, undefined);
    assert.equal(record.lastAgentExitCode, undefined);
    assert.equal(record.lastAgentExitAt, undefined);
    assert.equal(record.lastAgentDisconnectReason, undefined);
  });
});

test("exportSession ignores stale live process metadata on closed sessions", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const recordId = "closed-stale-live-record";
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid);

    try {
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecord({
          acpxRecordId: recordId,
          acpSessionId: recordId,
          agentCommand: AGENT_REGISTRY.codex,
          cwd,
          closed: true,
          closedAt: "2026-01-02T00:00:00.000Z",
          pid: child.pid,
        }),
      );
      await fs.writeFile(
        path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(recordId)}.stream.lock`),
        `${JSON.stringify({ pid: child.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );

      await exportSession({ agentCommand: AGENT_REGISTRY.codex, cwd, name: recordId }, archivePath);

      const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
        session?: { record_id?: string };
      };
      assert.equal(archive.session?.record_id, recordId);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
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
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid);

    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ pid: child.pid, created_at: new Date().toISOString() })}\n`,
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
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
  });
});

test("exportSession refuses a session owned by a live queue owner without an event lock", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const recordId = "live-record";
    await fs.mkdir(cwd, { recursive: true });

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid);

    try {
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecord({
          acpxRecordId: recordId,
          acpSessionId: recordId,
          agentCommand: AGENT_REGISTRY.codex,
          cwd,
          pid: child.pid,
        }),
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
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
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

test("importSession rejects archives that do not match the expected agent", async () => {
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

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session: { agent: string; state: { agent_command: string } };
    };
    archive.session.agent = AGENT_REGISTRY.claude;
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");

    await assert.rejects(
      importSession(archivePath, { expectedAgentCommand: AGENT_REGISTRY.codex }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "agent-mismatch");
        return true;
      },
    );

    archive.session.agent = AGENT_REGISTRY.codex;
    archive.session.state.agent_command = AGENT_REGISTRY.claude;
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");

    await assert.rejects(
      importSession(archivePath, { expectedAgentCommand: AGENT_REGISTRY.codex }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "agent-mismatch");
        return true;
      },
    );
  });
});

test("importSession accepts built-in agent archives across adapter command drift", async () => {
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
    await exportSession(
      { agentName: "codex", agentCommand: AGENT_REGISTRY.codex, cwd, name: "debug" },
      archivePath,
    );
    await fs.rm(sessionFilePath(homeDir, source.acpxRecordId));

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session: {
        agent?: string;
        agent_name?: string;
        state: { agent_command?: string };
      };
    };
    archive.session.agent = "npx -y @agentclientprotocol/codex-acp@^0.0.1";
    archive.session.agent_name = "codex";
    archive.session.state.agent_command = "npx -y @agentclientprotocol/codex-acp@^0.0.1";
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");

    const imported = await importSession(archivePath, {
      expectedAgentName: "codex",
      expectedAgentCommand: AGENT_REGISTRY.codex,
    });
    const record = await resolveSessionRecord(imported.record_id);

    assert.equal(record.agentCommand, AGENT_REGISTRY.codex);
  });
});

test("importSession ignores stale agent_name when commands match exactly", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    const source = makeSessionRecord({
      acpxRecordId: "source-record",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.openclaw,
      cwd,
      name: "debug",
    });
    await writeSessionRecordFile(homeDir, source);
    await exportSession(
      { agentName: "codex", agentCommand: AGENT_REGISTRY.openclaw, cwd, name: "debug" },
      archivePath,
    );
    await fs.rm(sessionFilePath(homeDir, source.acpxRecordId));

    const imported = await importSession(archivePath, {
      expectedAgentName: "openclaw",
      expectedAgentCommand: AGENT_REGISTRY.openclaw,
    });
    const record = await resolveSessionRecord(imported.record_id);

    assert.equal(record.agentCommand, AGENT_REGISTRY.openclaw);
  });
});

test("importSession rejects destination scope collisions", async () => {
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

    await assert.rejects(importSession(archivePath), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "session-scope-exists");
      assert.equal((error as { exitCode?: unknown }).exitCode, 2);
      return true;
    });
  });
});

test("importSession rejects archives whose provider session id already exists locally", async () => {
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

    await assert.rejects(importSession(archivePath, { name: "debug-copy" }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "session-provider-exists");
      assert.equal((error as { exitCode?: unknown }).exitCode, 2);
      return true;
    });
  });
});

test("importSession rejects provider session collisions across built-in command drift", async () => {
  await withTempHome("acpx-export-import-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    const oldCommand = "npx -y @agentclientprotocol/codex-acp@^0.0.1";
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "existing-record",
        acpSessionId: "provider-session",
        agentCommand: oldCommand,
        cwd,
        name: "old-debug",
      }),
    );

    const archive = {
      format_version: 1,
      exported_at: "2026-01-01T00:00:00.000Z",
      exported_by: "source-user",
      session: {
        record_id: "source-record",
        name: "debug",
        agent: oldCommand,
        agent_name: "codex",
        cwd_relative: ".",
        cwd_original: ".",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        state: serializeSessionRecordForDisk(
          makeSessionRecord({
            acpxRecordId: "source-record",
            acpSessionId: "provider-session",
            agentCommand: oldCommand,
            cwd,
            name: "debug",
          }),
        ),
      },
      history: [],
    };
    await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");

    await assert.rejects(
      importSession(archivePath, {
        name: "debug-copy",
        expectedAgentName: "codex",
        expectedAgentCommand: AGENT_REGISTRY.codex,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "session-provider-exists");
        return true;
      },
    );
  });
});
