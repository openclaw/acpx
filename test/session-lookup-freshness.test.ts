import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SessionNotFoundError, SessionResolutionError } from "../src/errors.js";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import {
  findSession,
  findSessionByDirectoryWalk,
  listSessions,
  listSessionsForAgent,
  pruneSessions,
  readSessionRecord,
  resolveSessionRecord,
  writeSessionRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

async function withIndexedRecords(
  run: (home: string, records: SessionRecord[]) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-lookup-freshness-", async (home) => {
    const records = ["first", "second", "third"].map((id, position) =>
      makeSessionRecord(
        {
          acpxRecordId: id,
          acpSessionId: `native-${id}`,
          agentCommand: position === 0 ? "agent-a" : "agent-b",
          cwd: path.join(home, position === 0 ? "repo" : "elsewhere"),
          lastUsedAt: `2026-01-0${3 - position}T00:00:00.000Z`,
        },
        { defaultName: false },
      ),
    );
    for (const record of records) {
      await writeSessionRecord(record);
    }
    // A legacy index remains stale when another canonical writer updates a record.
    const entries = records.map((record) => ({
      file: `${record.acpxRecordId}.json`,
      acpxRecordId: record.acpxRecordId,
      acpSessionId: record.acpSessionId,
      agentCommand: record.agentCommand,
      cwd: record.cwd,
      closed: record.closed,
      lastUsedAt: record.lastUsedAt,
    }));
    await fs.writeFile(
      path.join(home, ".acpx", "sessions", "index.json"),
      JSON.stringify({
        schema: "acpx.session-index.v1",
        files: entries.map((entry) => entry.file).toSorted(),
        entries,
      }),
    );
    await run(home, records);
  });
}

test("scope lookup finds a newer canonical match hidden by a valid cached hit", async () => {
  await withIndexedRecords(async (home, [first, second]) => {
    const store = createFileSessionStore({ stateDir: path.join(home, ".acpx") });
    second.agentCommand = first.agentCommand;
    second.cwd = first.cwd;
    second.lastUsedAt = "2026-02-01T00:00:00.000Z";
    await store.save(second);
    assert.equal((await findSession(first))?.acpxRecordId, second.acpxRecordId);
  });
});

for (const changed of ["closed", "cwd", "name", "agentCommand"] as const) {
  test(`scope lookup rejects a cached hit whose canonical ${changed} changed`, async () => {
    await withIndexedRecords(async (home, [first]) => {
      const query = { agentCommand: first.agentCommand, cwd: first.cwd };
      const store = createFileSessionStore({ stateDir: path.join(home, ".acpx") });
      if (changed === "closed") {
        first.closed = true;
      } else {
        first[changed] = changed === "cwd" ? path.join(home, "moved") : "changed";
      }
      await store.save(first);
      assert.equal(await findSession(query), undefined);
    });
  });
}

test("directory lookup prefers a newly matching nearer canonical record", async () => {
  await withIndexedRecords(async (home, [first, second]) => {
    second.agentCommand = first.agentCommand;
    second.cwd = path.join(first.cwd, "nested");
    await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).save(second);
    assert.equal(
      (
        await findSessionByDirectoryWalk({
          agentCommand: first.agentCommand,
          cwd: path.join(second.cwd, "child"),
          boundary: first.cwd,
        })
      )?.acpxRecordId,
      second.acpxRecordId,
    );
  });
});

test("agent listing applies membership and ordering to canonical records", async () => {
  await withIndexedRecords(async (home, [first, second, third]) => {
    const store = createFileSessionStore({ stateDir: path.join(home, ".acpx") });
    first.agentCommand = "agent-b";
    second.agentCommand = "agent-a";
    third.agentCommand = "agent-a";
    third.lastUsedAt = "2026-02-01T00:00:00.000Z";
    await Promise.all([store.save(first), store.save(second), store.save(third)]);
    assert.deepEqual(
      (await listSessionsForAgent("agent-a")).map((record) => record.acpxRecordId),
      [third.acpxRecordId, second.acpxRecordId],
    );
  });
});

for (const query of ["native-first", "first"] as const) {
  test(`canonical ID resolution detects hidden matches for ${query}`, async () => {
    await withIndexedRecords(async (home, [first, second]) => {
      // Avoid the intentionally preferred direct local-ID path for the suffix case.
      const id = query === "first" ? "-first" : query;
      second.acpSessionId = first.acpSessionId;
      await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).save(second);
      await assert.rejects(resolveSessionRecord(id), SessionResolutionError);
      assert.equal(
        (await resolveSessionRecord(first.acpxRecordId)).acpxRecordId,
        first.acpxRecordId,
      );
    });
  });
}

test("ID resolution forgets old IDs and discovers changed IDs", async () => {
  await withIndexedRecords(async (home, [first]) => {
    const previousId = first.acpSessionId;
    first.acpSessionId = "native-reconnected";
    await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).save(first);
    await assert.rejects(resolveSessionRecord(previousId), SessionNotFoundError);
    assert.equal((await resolveSessionRecord("reconnected")).acpxRecordId, first.acpxRecordId);
  });
});

test("prune discovers newly closed canonical records hidden by a stale index", async () => {
  await withIndexedRecords(async (home, [first]) => {
    first.closed = true;
    await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).save(first);
    assert.deepEqual(
      (await pruneSessions({ agentCommand: first.agentCommand, dryRun: true })).pruned.map(
        (record) => record.acpxRecordId,
      ),
      [first.acpxRecordId],
    );
    assert.ok(await fs.stat(sessionFilePath(home, first.acpxRecordId)));
  });
});

test("canonical writes and discovery do not depend on a writable legacy index", async () => {
  await withIndexedRecords(async (home, [first]) => {
    const indexPath = path.join(home, ".acpx", "sessions", "index.json");
    await fs.unlink(indexPath);
    await fs.mkdir(indexPath);
    first.name = "renamed";
    await writeSessionRecord(first);
    assert.equal((await findSession(first))?.name, "renamed");
    assert.equal((await listSessions()).length, 3);
    assert.ok((await fs.stat(indexPath)).isDirectory());
  });
});

test("discovery skips a corrupt latest record and still finds the next match", async () => {
  await withIndexedRecords(async (home, [first, second]) => {
    second.agentCommand = first.agentCommand;
    second.cwd = first.cwd;
    await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).save(second);
    await fs.writeFile(sessionFilePath(home, first.acpxRecordId), "{");
    assert.equal((await findSession(first))?.acpxRecordId, second.acpxRecordId);
  });
});

test("read-only lookup of absent storage creates no directory", async () => {
  await withTempHome("acpx-lookup-absent-", async (home) => {
    assert.equal(
      await findSession({ agentCommand: "agent", cwd: home, readOnly: true }),
      undefined,
    );
    await assert.rejects(fs.stat(path.join(home, ".acpx")), { code: "ENOENT" });
  });
});

test("exact canonical IDs take precedence over multiple suffix matches", async () => {
  await withIndexedRecords(async (home, records) => {
    const store = createFileSessionStore({ stateDir: path.join(home, ".acpx") });
    for (const [index, record] of records.entries()) {
      record.acpSessionId = index === 2 ? "shared-id" : `${index}-shared-id`;
      await store.save(record);
    }
    assert.equal((await resolveSessionRecord("shared-id")).acpxRecordId, records[2].acpxRecordId);
  });
});

test("direct local-ID resolution does not enumerate unrelated records", async (t) => {
  await withIndexedRecords(async (_home, [record]) => {
    t.mock.method(fs, "readdir", () => {
      throw new Error("Direct resolution must not scan the store");
    });
    assert.equal(
      (await resolveSessionRecord(record.acpxRecordId)).acpxRecordId,
      record.acpxRecordId,
    );
  });
});

test("checkpoint writes do not enumerate or read other records", async (t) => {
  await withIndexedRecords(async (_home, [record]) => {
    const failRead = () => {
      throw new Error("Saving one record must not read the store");
    };
    t.mock.method(fs, "readdir", failRead);
    t.mock.method(fs, "readFile", failRead);
    record.lastUsedAt = "2026-02-01T00:00:00.000Z";
    await writeSessionRecord(record);
    t.mock.restoreAll();
    assert.equal((await resolveSessionRecord(record.acpxRecordId)).lastUsedAt, record.lastUsedAt);
  });
});

test("direct ID lookup does not return a record with an unrelated canonical ID", async () => {
  await withIndexedRecords(async (home, [first]) => {
    await fs.copyFile(
      sessionFilePath(home, first.acpxRecordId),
      sessionFilePath(home, "unrelated"),
    );
    await assert.rejects(resolveSessionRecord("unrelated"), SessionNotFoundError);
    assert.equal(await readSessionRecord("unrelated"), undefined);
    assert.equal(
      await createFileSessionStore({ stateDir: path.join(home, ".acpx") }).load("unrelated"),
      undefined,
    );
    assert.equal((await resolveSessionRecord(first.acpSessionId)).acpxRecordId, first.acpxRecordId);
    assert.equal((await listSessions()).length, 3);
  });
});

test("a closed copy under another filename cannot authorize pruning the open original", async () => {
  await withIndexedRecords(async (home, [first]) => {
    const originalPath = sessionFilePath(home, first.acpxRecordId);
    const original = await fs.readFile(originalPath, "utf8");
    const copied = JSON.parse(original) as Record<string, unknown>;
    copied.closed = true;
    copied.last_used_at = "2026-02-01T00:00:00.000Z";
    const copyPath = sessionFilePath(home, "unrelated");
    await fs.writeFile(copyPath, JSON.stringify(copied));

    assert.deepEqual((await pruneSessions()).pruned, []);
    assert.equal(await fs.readFile(originalPath, "utf8"), original);
    assert.equal(await fs.readFile(copyPath, "utf8"), JSON.stringify(copied));
  });
});
