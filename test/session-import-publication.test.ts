import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listSessionEvents } from "../src/session/events.js";
import { exportSession } from "../src/session/export.js";
import { importSession } from "../src/session/import.js";
import { listSessions } from "../src/session/persistence.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const history = ["first", "second", "third"].map((text) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { text: `import-publication-${text}` },
}));

function historyPath(home: string, recordId: string): string {
  return path.join(home, ".acpx", "sessions", `${encodeURIComponent(recordId)}.stream.ndjson`);
}

async function importFixture(home: string) {
  const source = makeSessionRecord({
    acpxRecordId: "import-source",
    acpSessionId: "import-provider",
    agentCommand: "synthetic-import-agent",
    cwd: home,
    name: "import-target",
  });
  await writeSessionRecordFile(home, source);
  await fs.writeFile(
    historyPath(home, source.acpxRecordId),
    history.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const archive = path.join(home, "archive.json");
  await exportSession({ agentCommand: source.agentCommand, cwd: home, name: source.name }, archive);
  await fs.unlink(sessionFilePath(home, source.acpxRecordId));
  await fs.unlink(historyPath(home, source.acpxRecordId));
  const directory = await fs.realpath(path.join(home, ".acpx", "sessions"));
  return { archive, directory, source };
}

function finalRecord(target: string, directory: string): boolean {
  return path.dirname(target) === directory && target.endsWith(".json");
}

function ioFailure(): NodeJS.ErrnoException {
  return Object.assign(new Error("synthetic import publication failure"), { code: "EIO" });
}

test("failed imported-history publication leaves no discoverable session and permits retry", async (t) => {
  await withTempHome("acpx-import-publication-", async (home) => {
    const { archive, directory, source } = await importFixture(home);
    const sentinel = makeSessionRecord({
      acpxRecordId: "unrelated-record",
      acpSessionId: "unrelated-provider",
      agentCommand: "unrelated-agent",
      cwd: home,
      name: "unrelated",
    });
    await writeSessionRecordFile(home, sentinel);
    const sentinelHistory = "unrelated history must remain byte-identical\n";
    await fs.writeFile(historyPath(home, sentinel.acpxRecordId), sentinelHistory);
    const sentinelRecord = await fs.readFile(sessionFilePath(home, sentinel.acpxRecordId));
    const rename = fs.rename;
    const failure = ioFailure();
    let faulted = false;
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      const target = String(args[1]);
      if (path.dirname(target) === directory && target.endsWith(".stream.ndjson")) {
        faulted = true;
        throw failure;
      }
      return await rename(...args);
    });
    await assert.rejects(importSession(archive), (error: unknown) => error === failure);
    mocked.mock.restore();
    assert.equal(faulted, true);
    assert.deepEqual(
      (await listSessions()).map((record) => record.acpxRecordId),
      [sentinel.acpxRecordId],
    );
    assert.deepEqual(
      await fs.readFile(sessionFilePath(home, sentinel.acpxRecordId)),
      sentinelRecord,
    );
    assert.equal(
      await fs.readFile(historyPath(home, sentinel.acpxRecordId), "utf8"),
      sentinelHistory,
    );
    const imported = await importSession(archive);
    const record = (await listSessions()).find(
      (entry) => entry.acpxRecordId === imported.record_id,
    );
    assert.equal(record?.acpSessionId, source.acpSessionId);
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
  });
});

test("complete imported history exists before the canonical record can be discovered", async (t) => {
  await withTempHome("acpx-import-visibility-", async (home) => {
    const { archive, directory } = await importFixture(home);
    const rename = fs.rename;
    let recordTarget = "";
    let announce!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      const target = String(args[1]);
      if (finalRecord(target, directory)) {
        recordTarget = target;
        announce();
        await released;
      }
      return await rename(...args);
    });
    const importing = importSession(archive);
    try {
      await Promise.race([
        reached,
        importing.then(() => {
          throw new Error("Import bypassed the record-publication gate");
        }),
      ]);
      assert.deepEqual(await listSessions(), []);
      const recordId = decodeURIComponent(path.basename(recordTarget, ".json"));
      const payload = await fs.readFile(historyPath(home, recordId), "utf8");
      assert.deepEqual(
        payload
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
        history,
      );
    } finally {
      release();
      await importing;
      mocked.mock.restore();
    }
    const imported = await importing;
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
    assert.equal((await listSessions()).length, 1);
  });
});

test("failed record publication does not claim the import scope or provider", async (t) => {
  await withTempHome("acpx-import-record-failure-", async (home) => {
    const { archive, directory } = await importFixture(home);
    const rename = fs.rename;
    const failure = ioFailure();
    let faulted = false;
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      if (finalRecord(String(args[1]), directory)) {
        faulted = true;
        throw failure;
      }
      return await rename(...args);
    });
    await assert.rejects(importSession(archive), (error: unknown) => error === failure);
    mocked.mock.restore();
    assert.equal(faulted, true);
    assert.deepEqual(await listSessions(), []);
    const imported = await importSession(archive);
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
    assert.equal((await listSessions()).length, 1);
  });
});
