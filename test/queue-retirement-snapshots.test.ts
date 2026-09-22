import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SnapshotCase, SnapshotReport } from "./fixtures/queue-retirement-snapshots.js";
import { withTempHome } from "./queue-test-helpers.js";

const root = 2_000_001;
const fixture = fileURLToPath(new URL("./fixtures/queue-retirement-snapshots.js", import.meta.url));
async function run(mode: SnapshotCase, count: number): Promise<SnapshotReport> {
  let report: SnapshotReport | undefined;
  await withTempHome(async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [fixture, mode, String(count)], {
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" },
    });
    report = JSON.parse(stdout) as SnapshotReport;
  });
  assert(report);
  return report;
}

test(
  "Windows retirement snapshots preserve publication and signal boundaries",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async (t) => {
    for (const count of [1, 32]) {
      await t.test(`1.25-second queries retire ${count} survivors within the unchanged budget`, async () => {
        const result = await run("bounded", count);
        assert.equal(result.code, undefined);
        assert.equal(result.retained, false);
        assert.deepEqual(result.alive, []);
        assert.deepEqual(result.signals, Array.from({ length: count }, (_, i) => root + count - i));
        assert.deepEqual(result.queries, [null, root, null]);
        assert(result.guardBirths.length >= 3);
        assert(result.guardBirths.every((birth) => birth === "2026-09-21T09:00:00.0000000Z"));
      });
    }
    await t.test("missing self observation is carried through every guard without another discovery", async () => {
      const result = await run("missing-self", 2);
      assert.equal(result.code, undefined);
      assert.deepEqual(result.alive, []);
      assert.deepEqual(result.queries, [null, root, null]);
      assert(result.guardBirths.length >= 3 && result.guardBirths.every((birth) => birth === null));
    });
    await t.test("root birth replacement during publication never receives taskkill", async () => {
      const result = await run("root-replaced", 0);
      assert.equal(result.code, undefined);
      assert.deepEqual(result.alive, [root]);
      assert.deepEqual(result.signals, []);
      assert(!result.events.some(({ name }) => name === "taskkill"));
      assert.deepEqual(result.queries, [null, root]);
    });
    await t.test("new custody is published and reobserved before signals", async () => {
      const result = await run("new-custody", 2);
      assert.equal(result.code, undefined);
      assert.deepEqual(result.alive, [root + 2], "the replacement child stays alive");
      assert.deepEqual(result.signals, [root + 1]);
      const publication = result.events.findIndex(
        ({ name, pids }) => name === "publication" && pids?.includes(root + 2),
      );
      const fresh = result.events.findIndex(
        ({ name }, index) => index > publication && name === "query",
      );
      const signal = result.events.findIndex(({ name }) => name === "signal");
      assert(publication >= 0 && fresh > publication && signal > fresh);
    });
    await t.test("new custody publication failure preserves the prior receipt and every process", async () => {
      const result = await run("publication-failure", 2);
      assert.equal(result.code, "EIO");
      assert.equal(result.originalPreserved, true);
      assert.deepEqual(result.alive, [root + 1, root + 2]);
      assert.deepEqual(result.signals, []);
    });
    await t.test("one signal error cannot put an asynchronous probe inside the remaining batch", async () => {
      const result = await run("batch-error", 3);
      assert.equal(result.code, "EPERM");
      assert.equal(result.originalPreserved, true);
      assert.deepEqual(result.signals, [root + 3, root + 2, root + 1]);
      assert.deepEqual(result.alive, [root + 3]);
      const yielded = result.events.findIndex(({ name }) => name === "after-error-microtask");
      assert(result.events.every(({ name }, index) => name !== "signal" || index < yielded));
      assert.deepEqual(result.queries, [null, null]);
    });
    await t.test("a missing live row remains unknown and retains custody", async () => {
      const result = await run("missing", 1);
      assert.equal(result.code, "QUEUE_OWNER_RETIREMENT_INCOMPLETE");
      assert.equal(result.originalPreserved, true);
      assert.deepEqual(result.alive, [root + 1]);
      assert.deepEqual(result.signals, []);
    });
    await t.test("a reused parent PID cannot form a false cycle with its older child", async () => {
      const result = await run("reused-parent", 2);
      assert.equal(result.code, undefined);
      assert.equal(result.retained, false);
      assert.deepEqual(result.alive, []);
      assert.deepEqual(result.signals, [root + 2, root + 1]);
      assert.deepEqual(result.queries, [null, null]);
    });
    await t.test("an unexplained ancestry cycle still refuses all signals", async () => {
      const result = await run("parent-cycle", 2);
      assert.equal(result.code, "QUEUE_OWNER_RETIREMENT_INCOMPLETE");
      assert.equal(result.originalPreserved, true);
      assert.deepEqual(result.alive, [root + 1, root + 2]);
      assert.deepEqual(result.signals, []);
    });
    await t.test("a stalled survivor retains the receipt and full-query polling floor", async () => {
      const result = await run("poll", 1);
      assert.equal(result.code, "QUEUE_OWNER_RETIREMENT_INCOMPLETE");
      assert.equal(result.retained, true);
      assert.deepEqual(result.alive, [root + 1]);
      const queries = result.events.filter(({ name }) => name === "query");
      assert.equal(queries.length, 3);
      assert(queries[2].time - queries[1].time >= 2_250, "query cost plus at least a second of polling");
    });
  },
);
