import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { QueueConnectionError } from "../src/errors.js";
import { observeProcessIncarnation } from "../src/process-identity.js";
import { createSharedAcpRuntime } from "../src/runtime.js";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { probeQueueOwnerHealth } from "../src/session/queue/ipc-health.js";
import {
  isProcessAlive,
  readQueueOwnerRecord,
  resolveUsableQueueOwner,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  type QueueOwnerRecord,
} from "../src/session/queue/lease-store.js";
import { queueLockFilePath, queueSocketBaseDir } from "../src/session/queue/paths.js";
import { withTempHome } from "./queue-test-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

type Actor = {
  child: ChildProcess;
  exited: Promise<unknown>;
  pids: number[];
};

async function startActor(source: string): Promise<Actor> {
  const actorSource = `
    let onFixtureFinish = async () => {};
    let finishing = false;
    const finishFixture = async () => {
      if (finishing) return;
      finishing = true;
      try {
        await onFixtureFinish();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    };
    process.on('message', message => {
      if (message === 'finish') void finishFixture();
    });
    process.once('SIGTERM', () => void finishFixture());
    setTimeout(() => void finishFixture(), 30_000);
    ${source}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", actorSource], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      exited.then(() => {
        throw new Error(`Fixture exited before readiness: ${stderr}`);
      }),
    ]);
    assert(Array.isArray(message));
    assert(message.every((pid: unknown) => typeof pid === "number" && pid > 0));
    assert.equal(message[0], child.pid);
    return { child, exited, pids: message as number[] };
  } catch (error) {
    await stopActor({ child, exited, pids: child.pid ? [child.pid] : [] });
    throw error;
  }
}

async function waitForActorExit(actor: Actor): Promise<boolean> {
  let reaped = false;
  void actor.exited.then(() => {
    reaped = true;
  });
  // Fixed attempts keep cleanup bounded even when a test replaces Date.now.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (reaped && !actor.pids.some(isProcessAlive)) {
      return true;
    }
    await delay(20);
  }
  return reaped && !actor.pids.some(isProcessAlive);
}

async function stopActor(actor: Actor): Promise<void> {
  if (actor.child.connected) {
    actor.child.send("finish", () => {});
  }
  if (await waitForActorExit(actor)) {
    return;
  }
  // A recorded descendant PID is not permission to kill a later incarnation.
  // Only the live direct-child handle can support this single-process fallback.
  if (actor.pids.length === 1 && actor.child.exitCode == null && actor.child.signalCode == null) {
    actor.child.kill("SIGKILL");
  }
  assert.equal(
    await waitForActorExit(actor),
    true,
    `fixture cleanup left live PIDs: ${actor.pids.filter(isProcessAlive).join(", ")}`,
  );
}

async function startLeaseOwner(sessionId: string): Promise<Actor> {
  const moduleUrl = new URL("../src/session/queue/lease-store.js", import.meta.url).href;
  return await startActor(`
    const { tryAcquireQueueOwnerLease, releaseQueueOwnerLease } = await import(${JSON.stringify(moduleUrl)});
    const lease = await tryAcquireQueueOwnerLease(${JSON.stringify(sessionId)},
      () => '2000-01-01T00:00:00.000Z');
    if (!lease) throw new Error('Fixture could not acquire its lease');
    onFixtureFinish = () => releaseQueueOwnerLease(lease);
    process.send([process.pid]);
  `);
}

async function startSentinel(): Promise<Actor> {
  return await startActor(`
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const leaf = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30_000)'], {
      stdio: 'ignore',
    });
    const leafExited = once(leaf, 'close');
    onFixtureFinish = async () => {
      if (leaf.exitCode == null && leaf.signalCode == null) leaf.kill('SIGKILL');
      await leafExited;
    };
    leaf.once('spawn', () => process.send([process.pid, leaf.pid]));
  `);
}

async function withFixtureHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHome(async (homeDir) => {
    try {
      await run(homeDir);
    } finally {
      const socketDir = queueSocketBaseDir(homeDir);
      if (socketDir) {
        await fs.rmdir(socketDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
      }
    }
  });
}

const retirementPaths = {
  resolve: async (owner: QueueOwnerRecord) => {
    await resolveUsableQueueOwner(owner.sessionId, owner);
  },
  health: async (owner: QueueOwnerRecord) => {
    await probeQueueOwnerHealth(owner.sessionId);
  },
  collision: async (owner: QueueOwnerRecord) => {
    await tryAcquireQueueOwnerLease(owner.sessionId);
  },
  close: async (owner: QueueOwnerRecord) => {
    await terminateQueueOwnerForSession(owner.sessionId, owner);
  },
};

test(
  "public watch detects PID reuse without changing the sentinel or session",
  { timeout: 20_000 },
  async () => {
    await withFixtureHome(async (home) => {
      const sessionId = "watch-reused-owner";
      const original = await startLeaseOwner(sessionId);
      const runtime = createSharedAcpRuntime({ cwd: home, permissionMode: "deny-all" });
      const abort = new AbortController();
      let sentinel: Actor | undefined;
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded?.processIdentity);
        const session = makeSessionRecord({
          acpxRecordId: sessionId,
          acpSessionId: "provider-session",
          agentCommand: "fixture-agent",
          cwd: home,
          eventLog: defaultSessionEventLog(sessionId),
        });
        await writeSessionRecordFile(home, session);
        const writer = await SessionEventWriter.open(session);
        try {
          await writer.beginTurn("lost-owner");
        } finally {
          await writer.close();
        }
        original.child.kill("SIGKILL");
        await original.exited;
        if (process.platform !== "win32" && process.platform !== "linux") {
          // lstart records whole seconds; keep the two fixture births distinct.
          await delay(1_100);
        }
        sentinel = await startSentinel();
        const reused = { ...recorded, pid: sentinel.pids[0] };
        const lockPath = queueLockFilePath(sessionId);
        await fs.writeFile(lockPath, JSON.stringify(reused));
        assert.equal(await observeProcessIncarnation(reused.pid, reused.processIdentity), "gone");
        assert.deepEqual(sentinel.pids.map(isProcessAlive), [true, true]);
        const paths = [
          lockPath,
          sessionFilePath(home, sessionId),
          sessionEventActivePath(sessionId),
        ];
        const before = await Promise.all(paths.map((file) => fs.readFile(file, "utf8")));
        const events = runtime.watchSession({
          handle: {
            backend: "acpx-shared",
            sessionKey: sessionId,
            runtimeSessionName: sessionId,
            acpxRecordId: sessionId,
          },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4_000)]),
        });
        const iterator = events[Symbol.asyncIterator]();
        assert.equal((await iterator.next()).value?.type, "turn_started");
        process.stdout.write(
          `WATCH_REUSE_STARTED ${JSON.stringify({ pids: [...original.pids, ...sentinel.pids] })}\n`,
        );
        try {
          await assert.rejects(iterator.next(), { code: "WATCH_OUTCOME_UNKNOWN" });
        } finally {
          assert.deepEqual(sentinel.pids.map(isProcessAlive), [true, true]);
          assert.deepEqual(
            await Promise.all(paths.map((file) => fs.readFile(file, "utf8"))),
            before,
          );
          abort.abort();
          await iterator.return?.();
        }
      } finally {
        abort.abort();
        await runtime.shutdown();
        const actors = sentinel ? [original, sentinel] : [original];
        const stopped = await Promise.allSettled(actors.map(stopActor));
        process.stdout.write(
          `WATCH_REUSE_CLEANUP ${JSON.stringify({
            pids: actors.flatMap((actor) => actor.pids),
            alive: actors.flatMap((actor) => actor.pids).map(isProcessAlive),
            errors: stopped.flatMap((result) =>
              result.status === "rejected" ? [String(result.reason)] : [],
            ),
          })}\n`,
        );
        assert.ok(stopped.every((result) => result.status === "fulfilled"));
      }
    });
  },
);

for (const [name, retire] of Object.entries(retirementPaths)) {
  test(
    `state-equivalent PID reuse: ${name} preserves an unrelated sentinel`,
    { timeout: 20_000 },
    async () => {
      await withFixtureHome(async () => {
        const sessionId = `reused-owner-${name}`;
        const original = await startLeaseOwner(sessionId);
        let sentinel: Actor | undefined;
        try {
          const recorded = await readQueueOwnerRecord(sessionId);
          assert(recorded);
          original.child.kill("SIGKILL");
          await original.exited;
          assert.deepEqual(await readQueueOwnerRecord(sessionId), recorded);
          if (process.platform !== "win32" && process.platform !== "linux") {
            // POSIX lstart has one-second precision; model distinct incarnations.
            await delay(1_100);
          }
          sentinel = await startSentinel();

          // Model kernel PID recycling without host-wide process churn: preserve
          // the crashed owner's lease, replacing only its PID with our sentinel's.
          const reused = { ...recorded, pid: sentinel.pids[0] };
          await fs.writeFile(queueLockFilePath(sessionId), JSON.stringify(reused));
          assert.deepEqual(await readQueueOwnerRecord(sessionId), reused);
          assert.deepEqual(sentinel.pids.map(isProcessAlive), [true, true]);
          await retire(reused);
          assert.deepEqual(
            sentinel.pids.map(isProcessAlive),
            [true, true],
            "stale lease metadata must not authorize signaling an unrelated process or its child",
          );
          assert.equal(await readQueueOwnerRecord(sessionId), undefined);
        } finally {
          if (sentinel) {
            await stopActor(sentinel);
          }
          await stopActor(original);
        }
      });
    },
  );
}

test("a genuine stale queue owner is retired", { timeout: 20_000 }, async () => {
  await withFixtureHome(async () => {
    const sessionId = "genuine-stale-owner";
    const owner = await startLeaseOwner(sessionId);
    try {
      const recorded = await readQueueOwnerRecord(sessionId);
      assert(recorded);
      await resolveUsableQueueOwner(sessionId, recorded);
      await owner.exited;
      assert.equal(isProcessAlive(owner.child.pid), false);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      await stopActor(owner);
    }
  });
});

test(
  "an old observation preserves the same PID with a different lease generation",
  { timeout: 20_000 },
  async () => {
    await withFixtureHome(async () => {
      const sessionId = "same-pid-replacement-generation";
      const owner = await startLeaseOwner(sessionId);
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded);
        const replacement = { ...recorded, ownerGeneration: recorded.ownerGeneration + 1 };
        await fs.writeFile(queueLockFilePath(sessionId), JSON.stringify(replacement));
        await terminateQueueOwnerForSession(sessionId, recorded, true);
        assert.equal(isProcessAlive(owner.child.pid), true);
        assert.deepEqual(await readQueueOwnerRecord(sessionId), replacement);
      } finally {
        await stopActor(owner);
      }
    });
  },
);

test(
  "positive birth mismatch preserves a successor lease and endpoint",
  { timeout: 20_000 },
  async (t) => {
    await withFixtureHome(async () => {
      const sessionId = "reused-pid-successor-files";
      const owner = await startLeaseOwner(sessionId);
      let socketPath: string | undefined;
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded?.processIdentity);
        const stale = {
          ...recorded,
          processIdentity:
            recorded.processIdentity.kind === "linux-proc"
              ? {
                  ...recorded.processIdentity,
                  startTicks: (BigInt(recorded.processIdentity.startTicks) + 1n).toString(),
                }
              : {
                  kind: recorded.processIdentity.kind,
                  value:
                    process.platform === "win32"
                      ? "2000-01-01T00:00:00.0000000Z"
                      : "2000-01-01T00:00:00.000Z",
                },
        };
        const successor = { ...recorded, ownerGeneration: recorded.ownerGeneration + 1 };
        const lockPath = queueLockFilePath(sessionId);
        socketPath = recorded.socketPath;
        await fs.writeFile(lockPath, JSON.stringify(stale));
        const readFile = fs.readFile.bind(fs);
        let reads = 0;
        t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
          if (args[0] === lockPath && ++reads === 2) {
            // Publish the successor after the guarded identity observation, before
            // the cleanup guard rereads which generation owns these paths.
            await fs.writeFile(lockPath, JSON.stringify(successor));
            if (process.platform !== "win32") {
              await fs.writeFile(successor.socketPath, "successor endpoint");
            }
          }
          return await readFile(...args);
        });
        await terminateQueueOwnerForSession(sessionId, stale, true);
        assert.equal(isProcessAlive(owner.child.pid), true);
        assert.deepEqual(await readQueueOwnerRecord(sessionId), successor);
        if (process.platform !== "win32") {
          assert.equal(await fs.readFile(socketPath, "utf8"), "successor endpoint");
        }
      } finally {
        t.mock.restoreAll();
        await stopActor(owner);
        if (socketPath && process.platform !== "win32") {
          await fs.rm(socketPath, { force: true });
        }
      }
    });
  },
);

for (const uncertainty of ["legacy", "malformed", "incompatible", "query-failure"] as const) {
  test(
    `stale ${uncertainty} owner retains custody with a typed error`,
    { timeout: 20_000 },
    async () => {
      await withFixtureHome(async () => {
        const sessionId = `uncertain-owner-${uncertainty}`;
        const owner = await startLeaseOwner(sessionId);
        const queryEnv = process.platform === "win32" ? "SystemRoot" : "PATH";
        const previousQueryEnv = process.env[queryEnv];
        const previousExecPath = process.execPath;
        let socketPath: string | undefined;
        try {
          const recorded = await readQueueOwnerRecord(sessionId);
          assert(recorded?.processIdentity, "the fixture must first publish a verified owner");
          socketPath = recorded.socketPath;
          const raw: Record<string, unknown> = { ...recorded };
          if (uncertainty === "legacy") {
            delete raw.processIdentity;
          } else if (uncertainty === "malformed") {
            raw.processIdentity = { kind: recorded.processIdentity.kind, value: "invalid" };
          } else if (uncertainty === "incompatible") {
            raw.processIdentity =
              process.platform === "win32"
                ? { kind: "posix-lstart", value: "2026-01-01T00:00:00.000Z" }
                : { kind: "windows-creation", value: "2026-01-01T00:00:00.0000000Z" };
          }
          const payload = JSON.stringify(raw);
          await fs.writeFile(queueLockFilePath(sessionId), payload);
          if (process.platform !== "win32") {
            await fs.writeFile(socketPath, "retained endpoint");
          }
          const observed = await readQueueOwnerRecord(sessionId);
          assert(observed, "an invalid optional identity must not invalidate the lease");
          if (uncertainty === "query-failure") {
            // Native helper discovery fails while the already-published owner stays alive.
            process.env[queryEnv] = process.platform === "win32" ? "relative" : "";
            if (process.platform === "linux") {
              process.execPath = "/proc/self/acpx-missing-identity-helper";
            }
          }
          await assert.rejects(resolveUsableQueueOwner(sessionId, observed), (error) => {
            assert(error instanceof QueueConnectionError);
            assert.equal(error.detailCode, "QUEUE_OWNER_IDENTITY_UNVERIFIED");
            assert.equal(error.retryable, true);
            return true;
          });
          assert.equal(isProcessAlive(owner.child.pid), true);
          assert.equal(await fs.readFile(queueLockFilePath(sessionId), "utf8"), payload);
          if (process.platform !== "win32") {
            assert.equal(await fs.readFile(socketPath, "utf8"), "retained endpoint");
          }
        } finally {
          process.execPath = previousExecPath;
          if (previousQueryEnv === undefined) {
            delete process.env[queryEnv];
          } else {
            process.env[queryEnv] = previousQueryEnv;
          }
          await stopActor(owner);
          if (socketPath && process.platform !== "win32") {
            await fs.rm(socketPath, { force: true });
          }
        }
      });
    },
  );
}

test("healthy legacy owners remain reusable", { timeout: 20_000 }, async () => {
  await withFixtureHome(async () => {
    const sessionId = "healthy-legacy-owner";
    const owner = await startLeaseOwner(sessionId);
    try {
      const recorded = await readQueueOwnerRecord(sessionId);
      assert(recorded);
      const legacy = {
        ...recorded,
        processIdentity: undefined,
        heartbeatAt: new Date().toISOString(),
      };
      await fs.writeFile(queueLockFilePath(sessionId), JSON.stringify(legacy));
      assert.equal((await resolveUsableQueueOwner(sessionId, legacy))?.pid, owner.child.pid);
      assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
      assert.equal(isProcessAlive(owner.child.pid), true);
      assert.equal(
        (await readQueueOwnerRecord(sessionId))?.ownerGeneration,
        recorded.ownerGeneration,
      );
    } finally {
      await stopActor(owner);
    }
  });
});

test(
  "failed self discovery still publishes and refreshes an unverified lease",
  { timeout: 20_000 },
  async () => {
    await withFixtureHome(async () => {
      const sessionId = "unverified-self-publication";
      const moduleUrl = new URL("../src/session/queue/lease-store.js", import.meta.url).href;
      const owner = await startActor(`
      const { tryAcquireQueueOwnerLease, refreshQueueOwnerLease, releaseQueueOwnerLease } = await import(${JSON.stringify(moduleUrl)});
      const key = process.platform === 'win32' ? 'SystemRoot' : 'PATH';
      const previous = process.env[key];
      const previousExecPath = process.execPath;
      process.env[key] = '';
      if (process.platform === 'linux') process.execPath = '/proc/self/acpx-missing-identity-helper';
      const lease = await tryAcquireQueueOwnerLease(${JSON.stringify(sessionId)});
      if (!lease || lease.processIdentity) throw new Error('Expected an unverified published lease');
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      process.execPath = previousExecPath;
      await refreshQueueOwnerLease(lease, {queueDepth:2});
      onFixtureFinish = () => releaseQueueOwnerLease(lease);
      process.send([process.pid]);
    `);
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded);
        assert.equal(recorded.processIdentity, undefined);
        assert.equal(recorded.queueDepth, 2);
        assert.equal((await resolveUsableQueueOwner(sessionId, recorded))?.pid, owner.child.pid);
      } finally {
        await stopActor(owner);
      }
    });
  },
);

test(
  "explicit legacy retirement waits for cooperative exit and never force-kills",
  { timeout: 20_000 },
  async () => {
    await withFixtureHome(async () => {
      const sessionId = "legacy-cooperative-exit";
      const owner = await startLeaseOwner(sessionId);
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded);
        const legacy = { ...recorded, processIdentity: undefined };
        await fs.writeFile(queueLockFilePath(sessionId), JSON.stringify(legacy));
        const retiring = terminateQueueOwnerForSession(sessionId, legacy);
        await delay(process.platform === "win32" ? 2_500 : 100);
        assert.equal(
          isProcessAlive(owner.child.pid),
          true,
          "legacy PID must not receive a forced signal",
        );
        owner.child.send("finish");
        await retiring;
        await owner.exited;
        assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      } finally {
        await stopActor(owner);
      }
    });
  },
);

test(
  "explicit legacy retirement reports uncertainty after its passive wait budget",
  { timeout: 20_000 },
  async (t) => {
    await withFixtureHome(async () => {
      const sessionId = "legacy-cooperative-timeout";
      const owner = await startLeaseOwner(sessionId);
      try {
        const recorded = await readQueueOwnerRecord(sessionId);
        assert(recorded);
        const legacy = { ...recorded, processIdentity: undefined };
        const payload = JSON.stringify(legacy);
        await fs.writeFile(queueLockFilePath(sessionId), payload);
        const now = performance.now.bind(performance);
        const kill = process.kill.bind(process);
        let probes = 0;
        t.mock.method(performance, "now", () => now() + (probes >= 2 ? 60_000 : 0));
        t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
          const result = kill(pid, signal);
          // Let the canonical legacy observation return unknown, then expire
          // the passive wait on its first liveness probe without changing wall time.
          if (pid === owner.child.pid && signal === 0) {
            probes += 1;
          }
          return result;
        });
        await assert.rejects(terminateQueueOwnerForSession(sessionId, legacy), {
          detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
        });
        assert.equal(isProcessAlive(owner.child.pid), true);
        assert.equal(await fs.readFile(queueLockFilePath(sessionId), "utf8"), payload);
      } finally {
        t.mock.restoreAll();
        await stopActor(owner);
      }
    });
  },
);
