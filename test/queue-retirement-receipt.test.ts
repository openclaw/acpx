import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import { closeSession } from "../src/session/execution/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import {
  QueueLeaseGuardSettlementError,
  settlePendingQueueLeaseGuard,
} from "../src/session/queue/lease-mutation.js";
import {
  readQueueOwnerRecord,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  resolveUsableQueueOwner,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/session/queue/lease-store.js";
import {
  hasQueueRetirementReceipt,
  parseQueueRetirementReceipt,
} from "../src/session/queue/retirement-receipt.js";
import { withTempHome, verifiedProcessIdentity } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

const birth = { kind: "windows-creation" as const, value: "2026-09-21T10:00:00.0000000Z" };
const root = { pid: 2_000_001, processIdentity: birth };
const receipt = {
  ownerGeneration: 17,
  root,
  descendants: [{ pid: 2_000_002, processIdentity: birth }],
};
const owner = { ...root, ownerGeneration: receipt.ownerGeneration };

test("retirement receipt validates its root, generation and bounded witnesses", () => {
  assert.deepEqual(parseQueueRetirementReceipt(receipt, owner), receipt);
  const maximum = {
    ...receipt,
    descendants: Array.from({ length: 4_095 }, (_, i) => ({ pid: i + 10, processIdentity: birth })),
  };
  assert.equal(parseQueueRetirementReceipt(maximum, owner)?.descendants.length, 4_095);
  for (const raw of [
    null,
    [],
    {},
    { ...receipt, ownerGeneration: 18 },
    { ...receipt, root: { ...root, pid: root.pid + 1 } },
    { ...receipt, root: { ...root, processIdentity: { ...birth, value: "invalid" } } },
    { ...receipt, descendants: [root] },
    { ...receipt, descendants: [receipt.descendants[0], receipt.descendants[0]] },
    { ...receipt, descendants: [{ pid: 1, processIdentity: birth }] },
    { ...receipt, descendants: [{ pid: 3, processIdentity: { kind: "linux-proc" } }] },
    { ...receipt, descendants: [...maximum.descendants, { pid: 9_999, processIdentity: birth }] },
    { ...receipt, padding: "x".repeat(1024 * 1024) },
  ]) {
    assert.equal(parseQueueRetirementReceipt(raw, owner), null);
  }
});

test("any retirement field presence preserves rollback custody", () => {
  assert.equal(hasQueueRetirementReceipt({}), false);
  for (const retirement of [undefined, null, false, 0, "", {}, receipt]) {
    assert.equal(hasQueueRetirementReceipt({ retirement }), true);
  }
});

for (const invalid of [null, false, { padding: "x".repeat(1024 * 1024) }]) {
  test(`invalid retirement custody survives refresh, release and close (${typeof invalid})`, async () => {
    await withTempHome(async (home) => {
      const sessionId = "invalid-retirement";
      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert.ok(lease);
      const current = await readQueueOwnerRecord(sessionId);
      assert.ok(current);
      const payload = JSON.stringify({ ...current, retirement: invalid });
      await fs.writeFile(lease.lockPath, payload);
      await fs.utimes(lease.lockPath, 0, 0);
      const parsed = await readQueueOwnerRecord(sessionId);
      assert.ok(parsed);
      assert.equal(parsed.retirement, null);
      const expected = { detailCode: "QUEUE_OWNER_RETIREMENT_INCOMPLETE" };
      await assert.rejects(refreshQueueOwnerLease(lease, { queueDepth: 7 }), expected);
      await assert.rejects(releaseQueueOwnerLease(lease), expected);
      await assert.rejects(resolveUsableQueueOwner(sessionId, parsed), expected);
      await assert.rejects(tryAcquireQueueOwnerLease(sessionId), expected);
      await assert.rejects(terminateQueueOwnerForSession(sessionId), expected);
      await writeSessionRecordFile(
        home,
        makeSessionRecord({
          acpxRecordId: sessionId,
          acpSessionId: "backend",
          agentCommand: "unused",
          cwd: home,
        }),
      );
      await assert.rejects(closeSession(sessionId), expected);
      assert.equal((await resolveSessionRecord(sessionId)).closed, false);
      assert.equal(await fs.readFile(lease.lockPath, "utf8"), payload);
    });
  });
}

test("serialized refreshes preserve another process's admitted retirement receipt", async () => {
  await withTempHome(async () => {
    const keeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    const closed = once(keeper, "close");
    await once(keeper, "spawn");
    try {
      assert.ok(keeper.pid);
      const childIdentity =
        process.platform === "win32" ? await verifiedProcessIdentity(keeper.pid) : birth;
      const lease = await tryAcquireQueueOwnerLease("receipt-refresh");
      assert.ok(lease);
      const current = await readQueueOwnerRecord(lease.sessionId);
      assert.ok(current);
      const retirement = {
        ...receipt,
        ownerGeneration: lease.ownerGeneration,
        root: { pid: lease.pid, processIdentity: birth },
        descendants: [{ pid: keeper.pid, processIdentity: childIdentity }],
      };
      await fs.writeFile(
        lease.lockPath,
        JSON.stringify({ ...current, processIdentity: birth, retirement }),
      );
      await Promise.all(
        Array.from({ length: 24 }, (_, queueDepth) =>
          refreshQueueOwnerLease(lease, { queueDepth }),
        ),
      );
      const saved = await readQueueOwnerRecord(lease.sessionId);
      assert.deepEqual(saved?.retirement, retirement);
      assert.equal(saved?.queueDepth, 23);
      // A failed release retains the same receipt for another process to finish.
      await assert.rejects(releaseQueueOwnerLease(lease), {
        detailCode: "QUEUE_OWNER_RETIREMENT_INCOMPLETE",
      });
      assert.deepEqual((await readQueueOwnerRecord(lease.sessionId))?.retirement, retirement);
    } finally {
      keeper.kill("SIGKILL");
      await closed;
    }
  });
});

for (const retirement of [null, false, receipt]) {
  test(`acquisition rollback retains a receipt published after uncertain guard removal (${typeof retirement})`, async (t) => {
    await withTempHome(async () => {
      const sessionId = "rollback-retirement";
      const rm = fs.rm.bind(fs);
      let failed = false;
      t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        await rm(...args);
        if (!failed && String(args[0]).endsWith(".guard")) {
          failed = true;
          throw new Error("guard was removed but acknowledgement failed");
        }
      });
      await assert.rejects(tryAcquireQueueOwnerLease(sessionId), QueueLeaseGuardSettlementError);
      const current = await readQueueOwnerRecord(sessionId);
      assert.ok(current);
      const moduleUrl = new URL("../src/session/queue/lease-mutation.js", import.meta.url).href;
      const pathUrl = new URL("../src/session/queue/paths.js", import.meta.url).href;
      const writer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import fs from 'node:fs/promises';
        import {withQueueLeaseMutation} from ${JSON.stringify(moduleUrl)};
        import {queueLockFilePath} from ${JSON.stringify(pathUrl)};
        const id = ${JSON.stringify(sessionId)};
        await withQueueLeaseMutation(id, async () => {
          const file = queueLockFilePath(id);
          const record = JSON.parse(await fs.readFile(file, 'utf8'));
          record.retirement = ${JSON.stringify(retirement)};
          await fs.writeFile(file, JSON.stringify(record));
        });
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
      );
      let stderr = "";
      writer.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2_000);
      });
      const [code] = await once(writer, "close");
      assert.equal(code, 0, stderr);
      await settlePendingQueueLeaseGuard(sessionId);
      const saved = await readQueueOwnerRecord(sessionId);
      assert.equal(saved?.ownerGeneration, current.ownerGeneration);
      assert.notEqual(saved?.retirement, undefined);
    });
  });
}
