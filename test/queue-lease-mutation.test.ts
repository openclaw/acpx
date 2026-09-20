import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { probeQueueOwnerHealth } from "../src/session/queue/ipc-health.js";
import {
  QueueLeaseGuardSettlementError,
  settlePendingQueueLeaseGuard,
  withQueueLeaseMutation,
} from "../src/session/queue/lease-mutation.js";
import {
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  resolveUsableQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/session/queue/lease-store.js";
import { queueLockFilePath } from "../src/session/queue/paths.js";
import { withTempHome, writeQueueOwnerLock } from "./queue-test-helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a matching identity does not grant rollback authority without publication", async (t) => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("unpublished-collision");
    assert.ok(lease);
    const reservation = { ...lease, published: false };
    const collision = Object.assign(new Error("existing lease"), { code: "EEXIST" });
    const readFile = fs.readFile;
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string" && args[0].endsWith(path.basename(lease.lockPath))) {
        throw Object.assign(new Error("unowned rollback read denied"), { code: "EACCES" });
      }
      return await readFile(...args);
    });
    await assert.rejects(
      withQueueLeaseMutation(
        lease.sessionId,
        async () => {
          throw collision;
        },
        reservation,
      ),
      (error) => error === collision,
    );
    await assert.rejects(fs.access(`${lease.lockPath}.guard`), { code: "ENOENT" });
    t.mock.restoreAll();
    assert.equal(
      (await readQueueOwnerRecord(lease.sessionId))?.ownerGeneration,
      lease.ownerGeneration,
    );
    await releaseQueueOwnerLease(lease);
  });
});

test("status waits for acquisition settlement before reporting a usable owner", async (t) => {
  await withTempHome(async () => {
    const id = "status-during-settlement";
    const lockPath = queueLockFilePath(id);
    const entering = deferred();
    const proceed = deferred();
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`) && fail) {
        fail = false;
        entering.resolve();
        await proceed.promise;
        throw new Error("delayed acquisition settlement failure");
      }
      return await rm(...args);
    });
    const acquiring = assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    await entering.promise;
    let reported = false;
    const observing = readQueueOwnerStatus(id).then((value) => {
      reported = true;
      return value;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(reported, false, "status exposed an unadmitted owner");
    } finally {
      proceed.resolve();
      await acquiring;
      await settlePendingQueueLeaseGuard(id);
    }
    assert.equal(await observing, undefined);
    assert.equal(await readQueueOwnerRecord(id), undefined);
  });
});

test("owner resolution discards a snapshot rolled back during settlement", async (t) => {
  await withTempHome(async () => {
    const id = "resolved-after-settlement";
    const lockPath = queueLockFilePath(id);
    const entering = deferred();
    const proceed = deferred();
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`) && fail) {
        fail = false;
        entering.resolve();
        await proceed.promise;
        throw new Error("pending settlement failure");
      }
      return await rm(...args);
    });
    const acquiring = assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    await entering.promise;
    const snapshot = await readQueueOwnerRecord(id);
    assert.ok(snapshot);
    const resolving = resolveUsableQueueOwner(id, snapshot);
    proceed.resolve();
    await acquiring;
    assert.equal(await resolving, undefined);
    assert.equal(await readQueueOwnerRecord(id), undefined);
  });
});

test("failed acquisition settlement rolls back only the unadmitted reservation", async (t) => {
  await withTempHome(async () => {
    const id = "acquisition-settlement";
    const lockPath = queueLockFilePath(id);
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`) && fail) {
        fail = false;
        throw new Error("release failed");
      }
      return await rm(...args);
    });
    await assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    assert.ok(await readQueueOwnerRecord(id));
    await settlePendingQueueLeaseGuard(id);
    assert.equal(await readQueueOwnerRecord(id), undefined);
    await assert.rejects(fs.access(`${lockPath}.guard`), { code: "ENOENT" });
    const next = await tryAcquireQueueOwnerLease(id);
    assert.ok(next);
    await releaseQueueOwnerLease(next);
  });
});

test("uncertain acquisition guard removal reacquires exclusion and preserves a replacement", async (t) => {
  await withTempHome(async () => {
    const id = "uncertain-settlement";
    const lockPath = queueLockFilePath(id);
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      await rm(...args);
      if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`) && fail) {
        fail = false;
        throw new Error("release succeeded but acknowledgement failed");
      }
    });
    await assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    const unadmitted = await readQueueOwnerRecord(id);
    assert.ok(unadmitted);
    const replacement = {
      ...unadmitted,
      ownerGeneration: unadmitted.ownerGeneration + 1,
      lockPath,
    };
    await writeQueueOwnerLock(replacement);
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      assert.notEqual(args[0], lockPath, "rollback must preserve the replacement");
      return await unlink(...args);
    });
    await settlePendingQueueLeaseGuard(id);
    assert.equal((await readQueueOwnerRecord(id))?.ownerGeneration, replacement.ownerGeneration);
    await assert.rejects(fs.access(`${lockPath}.guard`), { code: "ENOENT" });
  });
});

test("uncertain release reacquires a guard before rolling back its own reservation", async (t) => {
  await withTempHome(async () => {
    const id = "uncertain-owned-settlement";
    const lockPath = queueLockFilePath(id);
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      await rm(...args);
      if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`) && fail) {
        fail = false;
        throw new Error("uncertain release");
      }
    });
    await assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    await assert.rejects(fs.access(`${lockPath}.guard`), { code: "ENOENT" });
    const unlink = fs.unlink;
    let rolledBack = false;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith(path.basename(lockPath))) {
        await fs.access(`${lockPath}.guard`);
        rolledBack = true;
      }
      return await unlink(...args);
    });
    await settlePendingQueueLeaseGuard(id);
    assert.equal(rolledBack, true);
    assert.equal(await readQueueOwnerRecord(id), undefined);
  });
});

test("mutation guard reclaims only definitely dead owners", async () => {
  await withTempHome(async () => {
    const id = "guard-dead-owner";
    const guardPath = `${queueLockFilePath(id)}.guard`;
    await fs.mkdir(path.dirname(guardPath), { recursive: true });
    await fs.writeFile(guardPath, JSON.stringify({ pid: 2147483647 }));
    const lease = await tryAcquireQueueOwnerLease(id);
    assert.ok(lease);
    await releaseQueueOwnerLease(lease);
    const ambiguous = "{}";
    await fs.writeFile(guardPath, ambiguous);
    await fs.utimes(guardPath, 0, 0);
    await assert.rejects(tryAcquireQueueOwnerLease(id));
    assert.equal(await fs.readFile(guardPath, "utf8"), ambiguous);
    assert.equal(await readQueueOwnerRecord(id), undefined);
  });
});

test("heartbeat settlement retains the published state and settles once for local waiters", async (t) => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("heartbeat-settlement");
    assert.ok(lease);
    if (process.platform !== "win32") {
      await fs.writeFile(lease.socketPath, "live endpoint");
    }
    const rm = fs.rm;
    let releases = 0;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(`${path.basename(lease.lockPath)}.guard`)) {
        releases += 1;
        if (releases === 1) {
          throw new Error("heartbeat release failed");
        }
      }
      return await rm(...args);
    });
    await assert.rejects(
      refreshQueueOwnerLease(lease, { queueDepth: 7 }),
      QueueLeaseGuardSettlementError,
    );
    assert.equal((await readQueueOwnerRecord(lease.sessionId))?.queueDepth, 7);
    assert.equal(releases, 1, "passive record reads do not settle guards");
    await Promise.all([
      settlePendingQueueLeaseGuard(lease.sessionId),
      settlePendingQueueLeaseGuard(lease.sessionId),
    ]);
    assert.equal(releases, 2);
    assert.equal((await readQueueOwnerRecord(lease.sessionId))?.queueDepth, 7);
    if (process.platform !== "win32") {
      assert.equal(await fs.readFile(lease.socketPath, "utf8"), "live endpoint");
    }
    await releaseQueueOwnerLease(lease);
  });
});

for (const readStatus of [readQueueOwnerStatus, probeQueueOwnerHealth]) {
  test(`${readStatus.name} settles failed cleanup even when the lease is missing`, async (t) => {
    await withTempHome(async () => {
      const lease = await tryAcquireQueueOwnerLease("missing-settlement");
      assert.ok(lease);
      const rm = fs.rm;
      let fail = true;
      t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (String(args[0]).endsWith(`${path.basename(lease.lockPath)}.guard`) && fail) {
          fail = false;
          throw new Error("cleanup release failed");
        }
        return await rm(...args);
      });
      await assert.rejects(releaseQueueOwnerLease(lease), QueueLeaseGuardSettlementError);
      assert.equal(await readQueueOwnerRecord(lease.sessionId), undefined);
      await fs.access(`${lease.lockPath}.guard`);
      await readStatus(lease.sessionId);
      await assert.rejects(fs.access(`${lease.lockPath}.guard`), { code: "ENOENT" });
    });
  });
}

test("mutation and repeated settlement failures preserve causes without replaying work", async (t) => {
  await withTempHome(async () => {
    const id = "repeated-settlement";
    const mutationError = new Error("mutation failed");
    const releaseError = new Error("guard release failed");
    const rm = fs.rm;
    let fail = true;
    let mutations = 0;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(".guard") && fail) {
        throw releaseError;
      }
      return await rm(...args);
    });
    await assert.rejects(
      withQueueLeaseMutation(id, async () => {
        mutations += 1;
        throw mutationError;
      }),
      (error: unknown) => {
        assert.ok(error instanceof QueueLeaseGuardSettlementError);
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [mutationError, releaseError]);
        return true;
      },
    );
    await assert.rejects(settlePendingQueueLeaseGuard(id), QueueLeaseGuardSettlementError);
    fail = false;
    await settlePendingQueueLeaseGuard(id);
    assert.equal(mutations, 1);
    await withQueueLeaseMutation(id, async () => {
      mutations += 1;
    });
    assert.equal(mutations, 2);
  });
});

test("a queued local mutation waits for the callback and settles its failed release", async (t) => {
  await withTempHome(async () => {
    const id = "queued-settlement";
    let continueFirst!: () => void;
    const proceed = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith(".guard") && fail) {
        fail = false;
        throw new Error("first release failed");
      }
      return await rm(...args);
    });
    const first = assert.rejects(
      withQueueLeaseMutation(id, async () => {
        entered();
        await proceed;
      }),
      QueueLeaseGuardSettlementError,
    );
    await entering;
    let ranSecond = false;
    const second = withQueueLeaseMutation(id, async () => {
      ranSecond = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ranSecond, false);
    continueFirst();
    await Promise.all([first, second]);
    assert.equal(ranSecond, true);
    await assert.rejects(fs.access(`${queueLockFilePath(id)}.guard`), { code: "ENOENT" });
  });
});
