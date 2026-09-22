import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [surface, scenario] = process.argv.slice(2);
const leaseScenario =
  scenario === "lease-refresh-unknown" || scenario === "lease-settlement-unknown";
const orphanPid = 2147483647;
const savedIdentity = {
  kind: "linux-proc",
  bootId: "11111111-1111-4111-8111-111111111111",
  pidNamespace: "pid:[4026531836]",
  // The positive no-CONFIG_TIME_NS case keeps both owners in the same scope.
  timeNamespace:
    scenario === "reused-unsupported-time-namespace" ? "unsupported" : "time:[4026531834]",
  startTicks: "100",
};
const blocked = [
  "other-kind",
  "foreign-pid-namespace",
  "foreign-time-namespace",
  "foreign-namespace-missing-pid",
].includes(scenario ?? "");
const expectedIdentity = (() => {
  switch (scenario) {
    case "malformed":
      return undefined;
    case "other-kind":
      return { kind: "posix-lstart", value: "2026-01-01T00:00:00.000Z" };
    case "foreign-pid-namespace":
    case "foreign-namespace-missing-pid":
      return { ...savedIdentity, pidNamespace: "pid:[4026539999]" };
    case "foreign-time-namespace":
      return { ...savedIdentity, timeNamespace: "time:[4026539999]" };
    case "prior-boot":
      return { ...savedIdentity, bootId: "22222222-2222-4222-8222-222222222222" };
    default:
      return savedIdentity;
  }
})();
const controller = new AbortController();
const cancelled = new Error("cancelled during identity query");
const queryTimes: number[] = [];
const signals: Array<Parameters<typeof process.kill>[1]> = [];
let ownQueries = 0;
let ownUnavailable = scenario === "publish-unverified" || leaseScenario;
let snapshots = 0;
let ownerExited = false;
let payloadAtExit: string | undefined;
let unexpectedPid: number | undefined;
let fixturePath: string;

Object.assign(globalThis, {
  guardIdentityFixture: {
    async getOwnProcessIdentity() {
      ownQueries += 1;
      if (ownUnavailable) {
        // A completed provider timeout returns no identity; it is not a new
        // discovery opportunity for every queued mutation of the same lease.
        await delay(10);
        return undefined;
      }
      return savedIdentity;
    },
    async observeProcessIncarnation(pid: number, expected: unknown, timeoutMs: number) {
      if (pid !== orphanPid) {
        unexpectedPid = pid;
      }
      assert.deepEqual(expected, expectedIdentity, "forward the parsed saved identity");
      assert.equal(timeoutMs, 1_000, "bound each foreign query");
      if (expected === undefined) {
        // Legacy/malformed records have only the canonical cheap PID check.
        try {
          process.kill(pid, 0);
          return "unknown";
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
        }
      }
      queryTimes.push(Date.now());
      if (scenario === "abort-probe") {
        controller.abort(cancelled);
        await delay(10);
      }
      if (blocked) {
        return "unknown";
      }
      if (ownerExited) {
        return "gone";
      }
      if (
        scenario === "unknown" ||
        (scenario === "unknown-during-reclaim" && queryTimes.length > 1) ||
        (scenario === "refresh-unknown" && queryTimes.length === 1)
      ) {
        return "unknown";
      }
      const matching =
        scenario === "matching" || (scenario === "refresh-matching" && queryTimes.length === 1);
      return matching ? "matching" : "gone";
    },
  },
});

// Isolate the OS observation seam in this child; fs-safe's real snapshots,
// retry loop and final reclaim callback still decide whether the fixture moves.
const identityUrl = new URL("../../src/process-identity.js", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith("/process-identity.js") &&
      new URL(specifier, context.parentURL).href === identityUrl
    ) {
      return { url: identityUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === identityUrl) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export * from ${JSON.stringify(`${identityUrl}?fixture-parser`)};
          export const getOwnProcessIdentity = globalThis.guardIdentityFixture.getOwnProcessIdentity;
          export const observeProcessIncarnation = globalThis.guardIdentityFixture.observeProcessIncarnation;
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { sessionEventLockPath } = await import("../../src/session/event-log.js");
const { queueLockFilePath } = await import("../../src/session/queue/paths.js");
const { QueueLeaseGuardSettlementError, settlePendingQueueLeaseGuard, withQueueLeaseMutation } =
  await import("../../src/session/queue/lease-mutation.js");
const { acquireSessionTurn } = await import("../../src/session/turn-ownership.js");
const id = "process-birth-fixture";
const marker = sessionEventLockPath(id);
const guard = `${surface === "mutation guard" ? queueLockFilePath(id) : marker}.guard`;
fixturePath = surface === "turn marker" ? marker : guard;
const publishing = scenario === "publish" || scenario === "publish-unverified" || leaseScenario;
const refresh = scenario === "refresh-matching" || scenario === "refresh-unknown";
const freshVeto = scenario === "unknown-during-reclaim";
const preserve =
  ["matching", "unknown", "malformed"].includes(scenario ?? "") ||
  (freshVeto && surface === "turn marker");
const fixturePayload = JSON.stringify({
  pid: orphanPid,
  created_at: "2000-01-01",
  processIdentity:
    scenario === "malformed" ? { kind: "linux-proc", startTicks: "100" } : expectedIdentity,
});
await fs.mkdir(path.dirname(fixturePath), { recursive: true });
if (!publishing) {
  await fs.writeFile(fixturePath, fixturePayload);
  await fs.utimes(fixturePath, 0, 0);
}

function observeSnapshot(file: unknown): void {
  if (path.basename(String(file)) !== path.basename(fixturePath)) {
    return;
  }
  snapshots += 1;
  if ((preserve || blocked) && snapshots >= 50) {
    payloadAtExit ??= fsSync.readFileSync(fixturePath, "utf8");
    ownerExited = preserve;
    if (blocked && surface !== "mutation guard") {
      controller.abort(cancelled);
    }
  }
}

// Guards use synchronous lstat snapshots; turn markers use the promise form.
// Count the real retry path so custody caching cannot make the fixture stall.
const lstatSync = fsSync.lstatSync;
fsSync.lstatSync = ((...args: Parameters<typeof fsSync.lstatSync>) => {
  const result = lstatSync(...args);
  observeSnapshot(args[0]);
  return result;
}) as typeof fsSync.lstatSync;
const lstat = fs.lstat;
fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  const result = await lstat(...args);
  observeSnapshot(args[0]);
  return result;
}) as typeof fs.lstat;

const kill = process.kill.bind(process);
process.kill = (...args: Parameters<typeof process.kill>) => {
  if (args[0] !== orphanPid) {
    return kill(...args);
  }
  signals.push(args[1]);
  if (ownerExited || scenario === "foreign-namespace-missing-pid") {
    throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
  }
  return true;
};

let admitted = false;
const published: Array<{ pid: number; processIdentity?: unknown }> = [];
const observeAdmission = async () => {
  admitted = true;
  published.push(JSON.parse(await fs.readFile(guard, "utf8")));
  if (surface !== "mutation guard") {
    published.push(JSON.parse(await fs.readFile(marker, "utf8")));
  }
};
const acquire = async () => {
  if (surface === "mutation guard") {
    await withQueueLeaseMutation(id, observeAdmission);
  } else {
    const turn = await acquireSessionTurn(
      id,
      AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    );
    try {
      await observeAdmission();
    } finally {
      await turn[Symbol.asyncDispose]();
    }
  }
};

function failNextGuardRelease(): () => void {
  const rm = fs.rm;
  let failed = false;
  fs.rm = async (...args: Parameters<typeof fs.rm>) => {
    await rm(...args);
    if (!failed && path.basename(String(args[0])) === path.basename(guard)) {
      failed = true;
      throw Object.assign(new Error("guard release failed after removal"), { code: "EIO" });
    }
  };
  return () => {
    fs.rm = rm;
  };
}

if (leaseScenario) {
  const { tryAcquireQueueOwnerLease, refreshQueueOwnerLease, releaseQueueOwnerLease } =
    await import("../../src/session/queue/lease-store.js");
  if (scenario === "lease-settlement-unknown") {
    const restore = failNextGuardRelease();
    try {
      await assert.rejects(tryAcquireQueueOwnerLease(id), QueueLeaseGuardSettlementError);
    } finally {
      restore();
    }
    assert.equal(ownQueries, 1, "failed admission still shares the captured identity");
    await fs.access(queueLockFilePath(id));
    await settlePendingQueueLeaseGuard(id);
    assert.equal(
      ownQueries,
      1,
      "settlement reacquires exclusion with its original identity receipt",
    );
  } else {
    const lease = await tryAcquireQueueOwnerLease(id);
    assert.ok(lease);
    assert.equal("processIdentity" in lease ? lease.processIdentity : undefined, undefined);
    assert.equal(ownQueries, 1, "lease and initial guard share one discovery result");
    await Promise.all(
      Array.from({ length: 24 }, (_, queueDepth) => refreshQueueOwnerLease(lease, { queueDepth })),
    );
    assert.equal(ownQueries, 1, "serialized refreshes must not repeat a timed-out discovery");
    const restore = failNextGuardRelease();
    try {
      await assert.rejects(releaseQueueOwnerLease(lease), QueueLeaseGuardSettlementError);
    } finally {
      restore();
    }
    await releaseQueueOwnerLease(lease);
    assert.equal(ownQueries, 1, "release and its retry use the same captured result");
  }
  await assert.rejects(fs.access(queueLockFilePath(id)), { code: "ENOENT" });
  await assert.rejects(fs.access(guard), { code: "ENOENT" });
  ownUnavailable = false;
  await withQueueLeaseMutation("later-operation", async () => {
    const record = JSON.parse(
      await fs.readFile(`${queueLockFilePath("later-operation")}.guard`, "utf8"),
    );
    assert.deepEqual(record.processIdentity, savedIdentity);
  });
  assert.equal(ownQueries, 2, "an independent operation can recover identity discovery");
} else if (blocked) {
  await assert.rejects(
    acquire,
    surface === "mutation guard"
      ? { code: "file_lock_timeout" }
      : (error) =>
          error === cancelled ||
          (error instanceof Error &&
            error.name === "AbortError" &&
            (error as NodeJS.ErrnoException).code === "ABORT_ERR" &&
            error.cause === cancelled),
  );
  assert.equal(admitted, false);
  assert.equal(await fs.readFile(fixturePath, "utf8"), fixturePayload);
  assert.equal(payloadAtExit, fixturePayload, "unknown scope preserves the unchanged lock");
  assert.ok(queryTimes.length > 0, "raw ESRCH cannot bypass canonical scope validation");
  assert.ok(queryTimes.length <= 3, "cache unknown scope only for the bounded wait");
} else if (scenario === "abort-probe") {
  await assert.rejects(acquire, (error) => error === cancelled);
  assert.equal(admitted, false);
  assert.equal(queryTimes.length, 1);
  assert.equal(await fs.readFile(fixturePath, "utf8"), fixturePayload);
} else {
  if (freshVeto && surface !== "turn marker") {
    // fs-safe refuses this acquisition after a fresh veto; it does not promise
    // to retry. A separate acquisition needs its own admissible observation.
    await assert.rejects(acquire, { code: "file_lock_stale" });
    assert.equal(admitted, false);
    assert.equal(queryTimes.length, 2);
    assert.equal(await fs.readFile(fixturePath, "utf8"), fixturePayload);
    await assert.rejects(fs.access(`${fixturePath}.reclaim`), { code: "ENOENT" });
    ownerExited = true;
  }
  await acquire();
  assert.equal(admitted, true);
  assert.equal(
    ownQueries,
    freshVeto && surface !== "turn marker" ? 2 : 1,
    "capture own birth once per acquisition, outside the lock retry loop",
  );
  for (const record of published) {
    assert.equal(record.pid, process.pid);
    assert.deepEqual(
      record.processIdentity,
      scenario === "publish-unverified" ? undefined : savedIdentity,
    );
  }
  if (preserve) {
    assert.equal(payloadAtExit, fixturePayload, "preserve custody until definite exit");
    assert.ok(snapshots >= 50, "exercise repeated real lock collisions");
    if (scenario === "malformed") {
      assert.equal(queryTimes.length, 0);
    } else {
      assert.ok(queryTimes.length > 0);
      const elapsed = Date.now() - queryTimes[0];
      assert.ok(
        queryTimes.length <= Math.ceil(elapsed / 1_000) + 3,
        "bound OS queries during retries",
      );
    }
  }
  if (freshVeto) {
    assert.ok(queryTimes.length >= 2, "fresh observation must veto deletion");
  }
  if (
    ["reused", "prior-boot", "reused-unsupported-time-namespace"].includes(scenario ?? "") ||
    refresh
  ) {
    assert.ok(queryTimes.length >= 2, "confirm the birth mismatch before deletion");
    assert.equal(payloadAtExit, undefined, "recover while the reused PID remains alive");
  }
  if (refresh) {
    assert.ok(snapshots >= 20, "cache must span acquisition retries");
    assert.ok(
      queryTimes[1] - queryTimes[0] >= 950,
      "refresh the bounded observation, not every retry",
    );
    assert.ok(queryTimes.length <= 3);
  }
  await assert.rejects(fs.access(fixturePath), { code: "ENOENT" });
}
assert.equal(unexpectedPid, undefined);
assert.ok(
  signals.every((signal) => signal === 0),
  "never signal a recycled PID",
);
