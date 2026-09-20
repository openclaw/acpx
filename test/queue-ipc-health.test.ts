import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import { probeQueueOwnerHealth } from "../src/session/queue/ipc.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test("probeQueueOwnerHealth clears stale dead owners even if a stray socket exists", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-stale-pid-healthy-socket";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
    });

    const server = net.createServer((socket) => {
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const health = await probeQueueOwnerHealth(sessionId);
      assert.equal(health.hasLease, false);
      assert.equal(health.healthy, false);
      assert.equal(health.socketReachable, false);
      assert.equal(health.pidAlive, false);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
    }
  });
});

test("probeQueueOwnerHealth reports unavailable socket when pid is alive", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-live-pid-missing-socket";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const keeper = await startKeeperProcess();

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });

      const health = await probeQueueOwnerHealth(sessionId);
      assert.equal(health.hasLease, true);
      assert.equal(health.healthy, false);
      assert.equal(health.socketReachable, false);
      assert.equal(health.pidAlive, true);
      assert.equal(typeof health.ownerGeneration, "number");
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("probeQueueOwnerHealth clears stale dead owner lock", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-dead-owner-cleanup";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
    });

    const health = await probeQueueOwnerHealth(sessionId);
    assert.equal(health.hasLease, false);
    assert.equal(health.healthy, false);
  });
});

test("probeQueueOwnerHealth does not attribute an old endpoint to a replacement generation", async (t) => {
  await withTempHome(async (homeDir) => {
    const sessionId = "probe-replaced-owner";
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ ...paths, sessionId, pid: process.pid, ownerGeneration: 1 });
    const raw = await fs.readFile(paths.lockPath, "utf8");
    const replacement = JSON.stringify({
      ...(JSON.parse(raw) as Record<string, unknown>),
      ownerGeneration: 2,
    });
    const readFile = fs.readFile;
    let observations = 0;
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === paths.lockPath && ++observations > 1) {
        return replacement;
      }
      return await readFile(...args);
    });
    const server = net.createServer((socket) => socket.end());
    await listenServer(server, paths.socketPath);
    try {
      const health = await probeQueueOwnerHealth(sessionId);
      assert.equal(health.healthy, false);
      assert.equal(health.socketReachable, false);
      assert.equal(health.ownerGeneration, undefined);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
    }
  });
});
