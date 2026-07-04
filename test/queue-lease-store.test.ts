import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ensureOwnerIsUsable,
  isProcessAlive,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir } from "../src/cli/queue/paths.js";
import {
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

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

test("tryAcquireQueueOwnerLease creates a lease that can be refreshed and released", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-create");
    assert(lease);
    assert.equal(lease.sessionId, "lease-create");

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
    assert.equal(record.heartbeatAt, "2026-03-26T00:00:00.000Z");

    await releaseQueueOwnerLease(lease);
    assert.equal(await readQueueOwnerRecord("lease-create"), undefined);
  });
});

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

test("ensureOwnerIsUsable cleans up stale live owners", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await ensureOwnerIsUsable(sessionId, owner), false);
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
