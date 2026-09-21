import assert from "node:assert/strict";
import childProcess, { ChildProcess, spawn, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ProcessBirthIdentity } from "../src/process-identity.js";
import {
  resolveUsableQueueOwner,
  isProcessAlive,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/session/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir } from "../src/session/queue/paths.js";
import {
  closeServer,
  connectSocket,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
  verifiedProcessIdentity,
} from "./queue-test-helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockPosixOwnerIdentity(
  context: TestContext,
  pid: number,
  birth = () => "Mon Sep 21 10:00:01 2026",
): ProcessBirthIdentity {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  context.mock.method(childProcess, "execFile", ((
    command: string,
    _args: readonly string[],
    _options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    assert.equal(command, "ps");
    queueMicrotask(() => callback(null, `${pid} 1 1 S ${birth()}\n`, ""));
    return new ChildProcess();
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });
  return { kind: "posix-lstart", value: "2026-09-21T10:00:01.000Z" };
}

test("readQueueOwnerRecord returns undefined for missing and malformed lock files", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "missing-record";
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lockPath = queueLockFilePath(sessionId, homeDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{not-json\n", "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    await fs.writeFile(lockPath, `${JSON.stringify({ pid: "bad" })}\n`, "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("owner control persistence capability accepts only literal true", async () => {
  await withTempHome(async (homeDir) => {
    const paths = queuePaths(homeDir, "control-capability");
    await writeQueueOwnerLock({ ...paths, sessionId: "control-capability", pid: process.pid });
    const original = JSON.parse(await fs.readFile(paths.lockPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const value of [undefined, false, "true", 1, true]) {
      await fs.writeFile(
        paths.lockPath,
        JSON.stringify({ ...original, persistsControlState: value }),
      );
      const record = await readQueueOwnerRecord("control-capability");
      assert.equal(record?.persistsControlState, value === true ? true : undefined);
    }
  });
});

test("tryAcquireQueueOwnerLease creates a lease that can be refreshed and released", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-create");
    assert(lease);
    assert.equal(lease.sessionId, "lease-create");
    assert.equal((await readQueueOwnerRecord("lease-create"))?.persistsControlState, true);

    await refreshQueueOwnerLease(
      lease,
      {
        queueDepth: 1.7,
      },
      () => "2026-03-26T00:00:00.000Z",
    );

    const record = await readQueueOwnerRecord("lease-create");
    assert(record);
    assert.equal(record.queueDepth, 2);
    assert.equal(record.persistsControlState, true);
    assert.equal(record.heartbeatAt, "2026-03-26T00:00:00.000Z");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(lease.lockPath)).mode & 0o777, 0o600);
    }

    await releaseQueueOwnerLease(lease);
    assert.equal(await readQueueOwnerRecord("lease-create"), undefined);
  });
});

test("lease acquisition does not publish a partially written record", async (context) => {
  await withTempHome(async () => {
    const lockPath = queueLockFilePath("lease-publication");
    const writing = deferred();
    const proceed = deferred();
    const writer = context.mock.method(
      fs,
      "writeFile",
      async (...[file, data, options]: Parameters<typeof fs.writeFile>) => {
        assert(typeof file === "string");
        const handle = await fs.open(file, "wx", 0o600);
        try {
          writing.resolve();
          await proceed.promise;
          await handle.writeFile(data, options);
        } finally {
          await handle.close();
        }
      },
    );
    const acquiring = tryAcquireQueueOwnerLease("lease-publication");
    try {
      await writing.promise;
      await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
    } finally {
      proceed.resolve();
      const lease = await acquiring;
      writer.mock.restore();
      assert(lease);
      const record = await readQueueOwnerRecord(lease.sessionId);
      assert.equal(record?.ownerGeneration, lease.ownerGeneration);
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("failed lease refresh preserves the last complete owner record", async (context) => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-failed-write");
    assert(lease);
    const original = await fs.readFile(lease.lockPath, "utf8");
    context.mock.method(fs, "writeFile", async (...[file]: Parameters<typeof fs.writeFile>) => {
      assert(typeof file === "string");
      const handle = await fs.open(file, "w", 0o600);
      await handle.close();
      throw new Error("injected write failure");
    });
    try {
      await assert.rejects(refreshQueueOwnerLease(lease, { queueDepth: 7 }), {
        message: "injected write failure",
      });
      assert.equal(await fs.readFile(lease.lockPath, "utf8"), original);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("lease acquisition preserves exclusivity without hardlink support", async (context) => {
  await withTempHome(async () => {
    const sessionId = "lease-no-hardlinks";
    const lockPath = queueLockFilePath(sessionId);
    const reserved = deferred();
    const proceed = deferred();
    const writeFile = fs.writeFile.bind(fs);
    context.mock.method(fs, "link", async () => {
      throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" });
    });
    context.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] !== lockPath) {
        await writeFile(...args);
        return;
      }
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        reserved.resolve();
        await proceed.promise;
        await handle.writeFile(args[1], args[2]);
      } finally {
        await handle.close();
      }
    });
    const acquiring = tryAcquireQueueOwnerLease(sessionId);
    let contending: ReturnType<typeof tryAcquireQueueOwnerLease> | undefined;
    try {
      await reserved.promise;
      contending = tryAcquireQueueOwnerLease(sessionId);
      await fs.utimes(lockPath, new Date(0), new Date(0));
      assert.equal(await fs.readFile(lockPath, "utf8"), "");
    } finally {
      proceed.resolve();
      const lease = await acquiring;
      assert(lease);
      assert.equal(await contending, undefined);
      assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, lease.ownerGeneration);
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("overlapping refreshes retain the latest queue depth", async (context) => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-ordered-refresh");
    assert(lease);
    const writing = deferred();
    const proceed = deferred();
    const writeFile = fs.writeFile.bind(fs);
    let first = true;
    context.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (first) {
        first = false;
        writing.resolve();
        await proceed.promise;
      }
      await writeFile(...args);
    });
    const firstRefresh = refreshQueueOwnerLease(lease, { queueDepth: 1 });
    await writing.promise;
    const secondRefresh = refreshQueueOwnerLease(lease, { queueDepth: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    proceed.resolve();
    try {
      await Promise.all([firstRefresh, secondRefresh]);
      assert.equal((await readQueueOwnerRecord(lease.sessionId))?.queueDepth, 2);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("release drains a pending refresh and rejects later refreshes", async (context) => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-drain");
    assert(lease);
    const writing = deferred();
    const proceed = deferred();
    const writeFile = fs.writeFile.bind(fs);
    context.mock.method(
      fs,
      "writeFile",
      async (...[file, data, options]: Parameters<typeof fs.writeFile>) => {
        writing.resolve();
        await proceed.promise;
        await writeFile(file, data, options);
      },
    );
    const refreshing = refreshQueueOwnerLease(lease, { queueDepth: 1 });
    await writing.promise;
    const releasing = releaseQueueOwnerLease(lease);
    proceed.resolve();
    await Promise.all([refreshing, releasing]);
    await refreshQueueOwnerLease(lease, { queueDepth: 2 });
    assert.equal(await readQueueOwnerRecord(lease.sessionId), undefined);
  });
});

test(
  "release waits outside the guard for a refresh awaiting its predecessor",
  { timeout: 5000 },
  async () => {
    await withTempHome(async () => {
      const lease = await tryAcquireQueueOwnerLease("lease-release-order");
      assert(lease);
      const predecessor = deferred();
      lease.updates = predecessor.promise;
      const refreshing = refreshQueueOwnerLease(lease, { queueDepth: 3 });
      const releasing = releaseQueueOwnerLease(lease);
      await new Promise<void>((resolve) => setImmediate(resolve));
      predecessor.resolve();
      await Promise.all([refreshing, releasing]);
      assert.equal(await readQueueOwnerRecord(lease.sessionId), undefined);
    });
  },
);

test("old lease refresh and release preserve a replacement owner and socket", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-replaced");
    assert(lease);
    const replacement = { ...lease, pid: process.pid, ownerGeneration: lease.ownerGeneration + 1 };
    await writeQueueOwnerLock(replacement);
    if (process.platform !== "win32") {
      await fs.writeFile(lease.socketPath, "replacement socket");
    }
    await refreshQueueOwnerLease(lease, { queueDepth: 9 });
    await releaseQueueOwnerLease(lease);
    assert.equal(
      (await readQueueOwnerRecord(lease.sessionId))?.ownerGeneration,
      replacement.ownerGeneration,
    );
    if (process.platform !== "win32") {
      assert.equal(await fs.readFile(lease.socketPath, "utf8"), "replacement socket");
      await fs.unlink(lease.socketPath);
    }
  });
});

test("release rechecks its generation after socket cleanup", async (context) => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-cleanup-race");
    assert(lease);
    const unlink = fs.unlink.bind(fs);
    context.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (args[0] === lease.socketPath) {
        await writeQueueOwnerLock({ ...lease, ownerGeneration: lease.ownerGeneration + 1 });
        await fs.writeFile(lease.socketPath, "replacement socket");
      } else {
        await unlink(...args);
      }
    });
    await releaseQueueOwnerLease(lease);
    assert.equal(
      (await readQueueOwnerRecord(lease.sessionId))?.ownerGeneration,
      lease.ownerGeneration + 1,
    );
    assert.equal(await fs.readFile(lease.socketPath, "utf8"), "replacement socket");
    await unlink(lease.socketPath);
  });
});

test("a same-process contender cannot reclaim its live lease", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-self");
    assert(lease);
    try {
      assert.equal(await tryAcquireQueueOwnerLease(lease.sessionId), undefined);
      assert.equal(
        (await readQueueOwnerRecord(lease.sessionId))?.ownerGeneration,
        lease.ownerGeneration,
      );
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("concurrent contenders acquire only one queue owner lease", async () => {
  await withTempHome(async () => {
    const leases = await Promise.all(
      Array.from({ length: 12 }, () => tryAcquireQueueOwnerLease("lease-concurrent")),
    );
    const acquired = leases.filter((lease) => lease !== undefined);
    try {
      assert.equal(acquired.length, 1);
      assert.equal(
        (await readQueueOwnerRecord("lease-concurrent"))?.ownerGeneration,
        acquired[0]?.ownerGeneration,
      );
    } finally {
      for (const lease of acquired) {
        await releaseQueueOwnerLease(lease);
      }
    }
  });
});

test("collision preserves fresh malformed reservations and recovers abandoned ones", async () => {
  await withTempHome(async () => {
    const sessionId = "lease-reservation";
    const lockPath = queueLockFilePath(sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{");
    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    assert.equal(await fs.readFile(lockPath, "utf8"), "{");
    await fs.utimes(lockPath, new Date(0), new Date(0));
    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    await releaseQueueOwnerLease(lease);
  });
});

test("stale health observations do not terminate a recovered heartbeat", async (context) => {
  await withTempHome(async (homeDir) => {
    const sessionId = "lease-recovered-heartbeat";
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, sessionId);
    try {
      await writeQueueOwnerLock({
        ...paths,
        sessionId,
        pid: keeper.pid,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });
      const stale = await readQueueOwnerRecord(sessionId);
      assert(stale);
      const heartbeatAt = new Date().toISOString();
      await writeQueueOwnerLock({ ...paths, ...stale, heartbeatAt });
      assert.equal((await resolveUsableQueueOwner(sessionId, stale))?.heartbeatAt, heartbeatAt);
      assert.equal(isProcessAlive(keeper.pid), true);
      assert(await readQueueOwnerRecord(sessionId));
      const readFile = fs.readFile.bind(fs);
      let first = true;
      context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === paths.lockPath && first) {
          first = false;
          return JSON.stringify(stale);
        }
        return await readFile(...args);
      });
      const status = await readQueueOwnerStatus(sessionId);
      assert.equal(status?.heartbeatAt, heartbeatAt);
      assert.equal(status?.stale, false);
      assert.equal(status?.alive, true);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("a final heartbeat cannot cancel termination already in progress", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX signal escalation; Windows retires the owner tree in one command");
    return;
  }
  await withTempHome(async (homeDir) => {
    const sessionId = "lease-retiring-heartbeat";
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      ...paths,
      sessionId,
      pid: 999_999,
      processIdentity: mockPosixOwnerIdentity(context, 999_999),
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    const owner = await readQueueOwnerRecord(sessionId);
    assert(owner);
    let alive = true;
    let now = Date.now();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    context.mock.method(Date, "now", () => now);
    context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, owner.pid);
      if (!alive) {
        throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      }
      if (signal === 0 && signals.includes("SIGTERM")) {
        now += 10_000;
        writeFileSync(
          paths.lockPath,
          JSON.stringify({ ...owner, heartbeatAt: new Date(now + 60_000).toISOString() }),
        );
      }
      if (signal === "SIGKILL") {
        alive = false;
      }
      if (signal !== 0) {
        signals.push(signal);
      }
      return true;
    });
    await resolveUsableQueueOwner(sessionId, owner);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test(
  "queue retirement rechecks OS birth before escalating to SIGKILL",
  { skip: process.platform === "win32" },
  async (context) => {
    await withTempHome(async (homeDir) => {
      const sessionId = "lease-escalation-pid-reuse";
      const paths = queuePaths(homeDir, sessionId);
      let birth = "Mon Sep 21 10:00:01 2026";
      await writeQueueOwnerLock({
        ...paths,
        sessionId,
        pid: 999_999,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        processIdentity: mockPosixOwnerIdentity(context, 999_999, () => birth),
      });
      let now = Date.now();
      context.mock.method(Date, "now", () => (now += 20_000));
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        assert.equal(pid, 999_999);
        if (signal !== 0) {
          signals.push(signal);
          birth = "Mon Sep 21 10:00:02 2026";
        }
        return true;
      });
      await terminateQueueOwnerForSession(sessionId);
      assert.deepEqual(signals, ["SIGTERM"], "a replacement incarnation must not receive SIGKILL");
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    });
  },
);

for (const permissionFailure of ["initial", "after-signal"] as const) {
  test(`ambiguous owner liveness ${permissionFailure} preserves lease and endpoint`, async (context) => {
    if (process.platform === "win32" && permissionFailure === "after-signal") {
      context.skip("POSIX signal escalation; Windows helper failures have separate coverage");
      return;
    }
    await withTempHome(async (homeDir) => {
      const sessionId = `lease-ambiguous-${permissionFailure}`;
      const paths = queuePaths(homeDir, sessionId);
      await writeQueueOwnerLock({
        ...paths,
        sessionId,
        pid: 999_999,
        processIdentity:
          permissionFailure === "after-signal"
            ? mockPosixOwnerIdentity(context, 999_999)
            : undefined,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });
      const original = await fs.readFile(paths.lockPath, "utf8");
      if (process.platform !== "win32") {
        await fs.mkdir(path.dirname(paths.socketPath), { recursive: true });
        await fs.writeFile(paths.socketPath, "retained endpoint");
      }
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      let now = Date.now();
      context.mock.method(Date, "now", () => now);
      context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        assert.equal(pid, 999_999);
        if (signal !== 0) {
          signals.push(signal);
          return true;
        }
        if (permissionFailure === "initial" || signals.length > 0) {
          if (signals.length > 0) {
            now += 10_000;
          }
          throw Object.assign(new Error("probe denied"), { code: "EPERM" });
        }
        return true;
      });
      try {
        if (permissionFailure === "initial") {
          await assert.rejects(terminateQueueOwnerForSession(sessionId, undefined, true), {
            detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
          });
        } else {
          await terminateQueueOwnerForSession(sessionId);
        }
        assert.equal(await fs.readFile(paths.lockPath, "utf8"), original);
        if (permissionFailure === "initial") {
          assert.deepEqual(signals, []);
          await assert.rejects(tryAcquireQueueOwnerLease(sessionId), {
            detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
          });
        } else {
          assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        }
        if (process.platform !== "win32") {
          assert.equal(await fs.readFile(paths.socketPath, "utf8"), "retained endpoint");
        }
      } finally {
        if (process.platform !== "win32") {
          await fs.rm(paths.socketPath, { force: true });
        }
      }
    });
  });
}

test("tryAcquireQueueOwnerLease persists MCP config path metadata", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-mcp-config", {
      path: "/tmp/job-mcp.json",
      fingerprint: "fingerprint-v1",
    });
    assert(lease);
    assert.equal(lease.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(lease.mcpConfigFingerprint, "fingerprint-v1");

    const record = await readQueueOwnerRecord("lease-mcp-config");
    assert(record);
    assert.equal(record.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(record.mcpConfigFingerprint, "fingerprint-v1");

    await refreshQueueOwnerLease(lease, { queueDepth: 2 });
    const refreshed = await readQueueOwnerRecord("lease-mcp-config");
    assert(refreshed);
    assert.equal(refreshed.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(refreshed.mcpConfigFingerprint, "fingerprint-v1");

    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease preserves the legacy clock callback argument", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease(
      "lease-clock-callback",
      () => "2026-03-26T00:00:00.000Z",
    );
    assert(lease);
    assert.equal(lease.createdAt, "2026-03-26T00:00:00.000Z");
    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease assigns collision-resistant owner generations", async () => {
  await withTempHome(async () => {
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    Date.now = () => 1_777_072_400_000;
    Math.random = () => 0;

    try {
      const first = await tryAcquireQueueOwnerLease("lease-generation-a");
      const second = await tryAcquireQueueOwnerLease("lease-generation-b");
      assert(first);
      assert(second);
      assert.notEqual(first.ownerGeneration, second.ownerGeneration);
      assert(Number.isSafeInteger(first.ownerGeneration));
      assert(Number.isSafeInteger(second.ownerGeneration));
      assert(first.ownerGeneration > 0);
      assert(second.ownerGeneration > 0);
      await releaseQueueOwnerLease(first);
      await releaseQueueOwnerLease(second);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
    }
  });
});

test("tryAcquireQueueOwnerLease tightens queue directory permissions", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const baseDir = queueBaseDir(homeDir);
    const socketDir = queueSocketBaseDir(homeDir);
    assert(socketDir);

    await fs.mkdir(baseDir, { recursive: true, mode: 0o777 });
    await fs.chmod(baseDir, 0o777);
    await fs.mkdir(socketDir, { recursive: true, mode: 0o777 });
    await fs.chmod(socketDir, 0o777);

    const lease = await tryAcquireQueueOwnerLease("lease-permissions");
    assert(lease);

    try {
      const baseMode = (await fs.stat(baseDir)).mode & 0o777;
      const socketMode = (await fs.stat(socketDir)).mode & 0o777;
      assert.equal(baseMode, 0o700);
      assert.equal(socketMode, 0o700);
    } finally {
      await releaseQueueOwnerLease(lease);
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("tryAcquireQueueOwnerLease clears stale dead owners and can acquire on retry", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-dead-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    await releaseQueueOwnerLease(lease);
  });
});

test("readQueueOwnerStatus returns live owner details for a healthy owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "healthy-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        queueDepth: 3,
      });

      const status = await readQueueOwnerStatus(sessionId);
      assert(status);
      assert.equal(status.pid, keeper.pid);
      assert.equal(status.alive, true);
      assert.equal(status.stale, false);
      assert.equal(status.queueDepth, 3);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  });
});

test("resolveUsableQueueOwner cleans up stale live owners", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity: await verifiedProcessIdentity(keeper.pid),
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await resolveUsableQueueOwner(sessionId, owner), undefined);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), false);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("tryAcquireQueueOwnerLease terminates stale live owners before retry acquisition", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner-acquire";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity: await verifiedProcessIdentity(keeper.pid),
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), false);

      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      await releaseQueueOwnerLease(lease);
    } finally {
      stopProcess(keeper);
    }
  });
});

test(
  "owner retirement waits for its replaced process and preserves a different-PID successor",
  { timeout: 5_000 },
  async (context) => {
    await withTempHome(async (homeDir) => {
      const sessionId = "retirement-successor";
      const paths = queuePaths(homeDir, sessionId);
      const retiring = spawn(
        process.execPath,
        ["-e", "process.on('message', () => process.exit(17)); process.send('ready');"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const ready = once(retiring, "message");
      const retired = once(retiring, "exit");
      const successor = await startKeeperProcess();
      const server = createSingleRequestServer(() => {});
      try {
        await ready;
        await writeQueueOwnerLock({ ...paths, sessionId, pid: retiring.pid });
        const observed = await readQueueOwnerRecord(sessionId);
        assert.ok(observed);
        await writeQueueOwnerLock({
          ...paths,
          ...observed,
          pid: successor.pid,
          ownerGeneration: observed.ownerGeneration + 1,
        });
        await listenServer(server, paths.socketPath);
        const saved = await fs.readFile(paths.lockPath, "utf8");
        const readFile = fs.readFile.bind(fs),
          kill = process.kill.bind(process);
        let successorObserved = false,
          probes = 0;
        const signals: Array<NodeJS.Signals | number | undefined> = [];
        context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
          const result = await readFile(...args);
          if (args[0] === paths.lockPath) {
            successorObserved = true;
          }
          return result;
        });
        context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
          if ((pid === retiring.pid || pid === successor.pid) && signal !== 0) {
            signals.push(signal);
          }
          const result = kill(pid, signal);
          // A skipped wait reaches the owner-alive assertion on its second probe;
          // a real retirement wait releases and observes the child's exit first.
          if (pid === retiring.pid && successorObserved && signal === 0 && ++probes === 2) {
            retiring.send("release");
          }
          return result;
        });
        await terminateQueueOwnerForSession(sessionId, observed);
        assert.equal(isProcessAlive(retiring.pid), false);
        assert.deepEqual(await retired, [17, null]);
        assert.deepEqual(signals, []);
        assert.equal(isProcessAlive(successor.pid), true);
        assert.equal(await fs.readFile(paths.lockPath, "utf8"), saved);
        const socket = await connectSocket(paths.socketPath);
        socket.destroy();
      } finally {
        stopProcess(retiring);
        stopProcess(successor);
        await retired;
        await closeServer(server);
      }
    });
  },
);

for (const disposition of ["replacement", "renewed"] as const) {
  test(
    `owner retirement preserves a ${disposition} lease without waiting for its live process`,
    { timeout: 5_000 },
    async () => {
      await withTempHome(async (homeDir) => {
        const sessionId = `retirement-${disposition}`;
        const keeper = await startKeeperProcess();
        const paths = queuePaths(homeDir, sessionId);
        try {
          await writeQueueOwnerLock({
            ...paths,
            sessionId,
            pid: keeper.pid,
            heartbeatAt: "2000-01-01T00:00:00.000Z",
          });
          const observed = await readQueueOwnerRecord(sessionId);
          assert.ok(observed);
          const successor = {
            ...paths,
            ...observed,
            ownerGeneration: observed.ownerGeneration + (disposition === "replacement" ? 1 : 0),
            heartbeatAt: new Date().toISOString(),
          };
          await writeQueueOwnerLock(successor);
          if (process.platform !== "win32") {
            await fs.mkdir(path.dirname(paths.socketPath), { recursive: true });
            await fs.writeFile(paths.socketPath, "owned endpoint");
          }
          const saved = await fs.readFile(paths.lockPath, "utf8");
          await terminateQueueOwnerForSession(sessionId, observed, disposition === "renewed");
          assert.equal(isProcessAlive(keeper.pid), true);
          assert.equal(await fs.readFile(paths.lockPath, "utf8"), saved);
          if (process.platform !== "win32") {
            assert.equal(await fs.readFile(paths.socketPath, "utf8"), "owned endpoint");
          }
        } finally {
          stopProcess(keeper);
          if (process.platform !== "win32") {
            await fs.rm(paths.socketPath, { force: true });
          }
        }
      });
    },
  );
}

test("terminateProcess and terminateQueueOwnerForSession handle live and missing owners", async () => {
  await withTempHome(async (homeDir) => {
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(process.pid), false);
    assert.equal(await terminateProcess(999_999), false);

    const sessionId = "terminate-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert.equal(isProcessAlive(keeper.pid), true);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity: await verifiedProcessIdentity(keeper.pid),
        sessionId,
        socketPath,
      });

      await terminateQueueOwnerForSession(sessionId);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("terminateProcess does not report termination while the process remains alive", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => (now += 10_000));
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, 999_999);
    if (signal !== 0) {
      signals.push(signal);
    }
    return true;
  });
  assert.equal(await terminateProcess(999_999), false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("terminateProcess waits long enough for a process that delays 2s before exiting on SIGTERM", async () => {
  // Regression test for the SIGTERM grace-period mismatch.
  //
  // A queue-owner's AcpClient.close() can take up to ~2 600 ms (stdin-close
  // 100 ms + SIGTERM wait 1 500 ms + SIGKILL wait 1 000 ms).  The old
  // PROCESS_EXIT_GRACE_MS of 1 500 ms would SIGKILL the owner before it
  // finished closing its bridge.  PROCESS_SIGTERM_GRACE_MS = 4 000 ms gives
  // sufficient headroom.
  //
  // This test spawns a Node.js process that defers its exit by 2 000 ms after
  // receiving SIGTERM and verifies that terminateProcess() returns true without
  // needing to escalate to SIGKILL (i.e. the process exits on its own within
  // the 4 s window).
  if (process.platform === "win32") {
    // SIGTERM semantics differ on Windows.
    return;
  }

  // The child writes "ready\n" to stderr once its SIGTERM handler is installed.
  // We wait for that line before sending SIGTERM to avoid the race where the
  // signal arrives before the handler is registered.
  const script = `
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 2_000);
    });
    process.stderr.write('ready\\n');
    // Keep the event loop alive until SIGTERM arrives.
    setInterval(() => {}, 60_000);
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for the "ready" signal before sending SIGTERM.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("ready")) {
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", () => reject(new Error("child exited before signalling ready")));
  });

  assert(child.pid, "child must have a pid");

  try {
    assert.equal(isProcessAlive(child.pid), true, "child must be alive before terminateProcess");
    const result = await terminateProcess(child.pid);
    assert.equal(result, true, "terminateProcess must return true");
    assert.equal(isProcessAlive(child.pid), false, "process must be dead after terminateProcess");

    // Wait for the ChildProcess object to pick up the close event so that
    // exitCode / signalCode are populated.
    if (child.exitCode == null && child.signalCode == null) {
      await once(child, "close");
    }

    // The process should have exited with code 0 (clean exit via setTimeout),
    // not killed by a signal, proving the 4 s SIGTERM grace was enough.
    assert.equal(
      child.signalCode,
      null,
      `process should have exited cleanly, not via signal ${child.signalCode}`,
    );
    assert.equal(child.exitCode, 0, "process must exit with code 0");
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  }
});
