import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { writeSessionRecord as persistSessionRecord } from "../src/session/persistence.js";
import {
  fileExists,
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?prune_test=${cacheBuster}`)) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-prune-test-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

test("pruneSessions returns empty result when no closed sessions exist", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "open-session",
        acpSessionId: "open-session",
        agentCommand: "agent-a",
        cwd,
        closed: false,
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 0);
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.dryRun, false);
  });
});

test("pruneSessions deletes closed session files and removes them from the index", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "closed-session",
        acpSessionId: "closed-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const filePath = sessionFilePath(homeDir, "closed-session");
    assert.ok(await fileExists(filePath));

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "closed-session");
    assert.ok(result.bytesFreed > 0);
    assert.equal(result.dryRun, false);
    assert.ok(!(await fileExists(filePath)));
  });
});

test("pruneSessions --dry-run does not delete files but returns correct count", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "dry-run-session",
        acpSessionId: "dry-run-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const filePath = sessionFilePath(homeDir, "dry-run-session");
    assert.ok(await fileExists(filePath));

    const result = await session.pruneSessions({ agentCommand: "agent-a", dryRun: true });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.dryRun, true);
    assert.ok(await fileExists(filePath));
  });
});

test("pruneSessions --before uses closedAt before falling back to lastUsedAt", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "old-session",
        acpSessionId: "old-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2025-06-01T00:00:00.000Z",
        lastUsedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "recent-session",
        acpSessionId: "recent-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-03-01T00:00:00.000Z",
        lastUsedAt: "2025-06-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      before: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "old-session");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "old-session"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "recent-session")));
  });
});

test("pruneSessions --older-than prunes sessions beyond the day threshold", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    // Session with lastUsedAt far in the past
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "ancient-session",
        acpSessionId: "ancient-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2020-01-01T00:00:00.000Z",
        lastUsedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    // Session with lastUsedAt very recently (should not be pruned)
    const now = new Date().toISOString();
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "fresh-session",
        acpSessionId: "fresh-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: now,
        lastUsedAt: now,
      }),
    );

    // Prune sessions older than 1 day
    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      olderThanMs: 1 * 24 * 60 * 60 * 1000,
    });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "ancient-session");
    assert.ok(await fileExists(sessionFilePath(homeDir, "fresh-session")));
  });
});

test("pruneSessions scoped to agentCommand only prunes that agent's sessions", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "agent-a-session",
        acpSessionId: "agent-a-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "agent-b-session",
        acpSessionId: "agent-b-session",
        agentCommand: "agent-b",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "agent-a-session");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "agent-a-session"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "agent-b-session")));
  });
});

test("pruneSessions --include-history deletes stream files", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "stream-session",
        acpSessionId: "stream-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const safeId = encodeURIComponent("stream-session");
    const streamFile = path.join(sessionsDir, `${safeId}.stream.ndjson`);
    const streamSegment = path.join(sessionsDir, `${safeId}.stream.0.ndjson`);
    const streamLock = path.join(sessionsDir, `${safeId}.stream.lock`);
    const neighborStreamFile = path.join(
      sessionsDir,
      `${encodeURIComponent("stream-session.stream-neighbor")}.stream.ndjson`,
    );
    await fs.writeFile(streamFile, "event-data\n", "utf8");
    await fs.writeFile(streamSegment, "segment-data\n", "utf8");
    await fs.writeFile(streamLock, "", "utf8");
    await fs.writeFile(neighborStreamFile, "neighbor-data\n", "utf8");

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      includeHistory: true,
    });
    assert.equal(result.pruned.length, 1);
    assert.ok(result.bytesFreed > 0);
    assert.ok(!(await fileExists(streamFile)));
    assert.ok(!(await fileExists(streamSegment)));
    assert.ok(!(await fileExists(streamLock)));
    assert.ok(await fileExists(neighborStreamFile));
  });
});

test("pruneSessions preserves neighboring records with stream-like IDs", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");
    for (const id of ["parent", "parent.stream.child", "parent.stream.0"]) {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "agent-a",
          cwd,
          closed: id === "parent",
        }),
      );
      await fs.writeFile(path.join(sessionsDir, `${id}.stream.ndjson`), `${id}\n`);
    }
    const unrelated = [
      "parent.stream.child.json",
      "parent.stream.child.stream.ndjson",
      "parent.stream.0.json",
      "parent.stream.0.stream.ndjson",
      "parent.stream.notes.ndjson",
      "parent.stream.0.ndjson.backup",
    ];
    await fs.writeFile(path.join(sessionsDir, "parent.stream.0.ndjson"), "segment\n");
    await fs.writeFile(path.join(sessionsDir, "parent.stream.notes.ndjson"), "notes\n");
    await fs.writeFile(path.join(sessionsDir, "parent.stream.0.ndjson.backup"), "backup\n");
    const before = await Promise.all(
      unrelated.map((name) => fs.readFile(path.join(sessionsDir, name), "utf8")),
    );

    const result = await session.pruneSessions({ includeHistory: true });

    assert.deepEqual(
      result.pruned.map((record) => record.acpxRecordId),
      ["parent"],
    );
    assert.equal(await fileExists(path.join(sessionsDir, "parent.stream.ndjson")), false);
    assert.equal(await fileExists(path.join(sessionsDir, "parent.stream.0.ndjson")), false);
    assert.deepEqual(
      await Promise.all(unrelated.map((name) => fs.readFile(path.join(sessionsDir, name), "utf8"))),
      before,
    );
  });
});

test("pruneSessions rechecks canonical records when index metadata is stale", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const records = ["reopened", "changed-agent", "eligible"].map((id) =>
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "agent-a",
        cwd,
        closed: true,
      }),
    );
    for (const record of records) {
      await persistSessionRecord(record);
    }
    // Concurrent index writers can leave older metadata beside newer canonical records.
    await writeSessionRecord(homeDir, { ...records[0], closed: false });
    await writeSessionRecord(homeDir, { ...records[1], agentCommand: "agent-b" });

    const preview = await session.pruneSessions({ agentCommand: "agent-a", dryRun: true });
    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.deepEqual(
      preview.pruned.map((record) => record.acpxRecordId),
      ["eligible"],
    );
    assert.deepEqual(
      result.pruned.map((record) => record.acpxRecordId),
      ["eligible"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "reopened")));
    assert.ok(await fileExists(sessionFilePath(homeDir, "changed-agent")));
  });
});

test("pruneSessions without agentCommand prunes all closed sessions across all agents", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-a",
        acpSessionId: "all-a",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-b",
        acpSessionId: "all-b",
        agentCommand: "agent-b",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-open",
        acpSessionId: "all-open",
        agentCommand: "agent-a",
        cwd,
        closed: false,
      }),
    );

    const result = await session.pruneSessions({});
    assert.equal(result.pruned.length, 2);
    const prunedIds = result.pruned.map((r) => r.acpxRecordId).toSorted();
    assert.deepEqual(prunedIds, ["all-a", "all-b"]);
    assert.ok(await fileExists(sessionFilePath(homeDir, "all-open")));
  });
});
