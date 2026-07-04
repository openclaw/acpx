/**
 * Tests that the queue owner runtime shuts down gracefully on SIGTERM/SIGINT,
 * so the codex-acp bridge adapter is never orphaned.
 *
 * See: src/cli/session/queue-owner-runtime.ts — the `runSessionQueueOwner`
 * function previously had no signal handlers; SIGTERM from lease-store's
 * terminateProcess() killed the Node process before the `finally` block could
 * run closeQueueOwnerRuntime(), leaving bridge adapters orphaned.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath, queueSocketPath } from "../src/cli/queue/paths.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 6_000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function waitForTerminalQueueMessage(
  iterator: AsyncIterator<string>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout waiting for queue result")),
            timeoutMs,
          );
        }),
      ]);
      if (line.done) {
        throw new Error("queue socket closed before terminal result");
      }
      const message = JSON.parse(line.value) as Record<string, unknown>;
      if (message.type === "result" || message.type === "error") {
        return message;
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`Queue result not received within ${timeoutMs}ms`);
}

function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Queue owner process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("queue owner lifecycle — graceful SIGTERM shutdown", () => {
  it("exits with code 0 and releases its lease when it receives SIGTERM", async () => {
    if (process.platform === "win32") {
      // SIGTERM semantics differ on Windows; skip this test.
      return;
    }

    await withTempHome("acpx-lifecycle-sigterm-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      // A minimal session record — the queue owner reads it during startup.
      // The agent bridge is only spawned when the first prompt is run, so
      // we just need any plausible agentCommand to pass startup validation.
      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-sigterm-test",
        acpSessionId: "lifecycle-sigterm-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);

      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      // Waiting for the socket avoids signaling before startup installs the
      // queue-owner process handlers.
      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      // Queue owner payload — no ttlMs so it waits indefinitely for tasks.
      const payload = JSON.stringify({
        sessionId: record.acpxRecordId,
        permissionMode: "approve-reads",
      });

      const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], {
        env: {
          ...process.env,
          HOME: homeDir,
          ACPX_QUEUE_OWNER_PAYLOAD: payload,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      try {
        // Wait until the queue owner has created its Unix socket and entered
        // the idle task loop.
        await waitUntil(() => fileExists(socketPath));

        // Confirm the lock file is present before sending the signal.
        assert.equal(await fileExists(lockPath), true, "lock file must exist before SIGTERM");

        // Signal graceful shutdown.
        child.kill("SIGTERM");

        const { code, signal } = await waitForProcessExit(child);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        // Graceful shutdown: exit code 0, not killed by a signal.
        assert.equal(
          signal,
          null,
          `process should not have been killed by a signal; stderr=${stderr}`,
        );
        assert.equal(code, 0, `expected exit code 0 (graceful); stderr=${stderr}`);

        // The lease must have been released: no orphaned lock file.
        assert.equal(
          await fileExists(lockPath),
          false,
          "lock file must be gone after graceful shutdown — lease was not released",
        );
      } finally {
        // Safety net: kill the child if the test fails mid-way.
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });

  it("exits with code 0 and releases its lease when it receives SIGINT", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempHome("acpx-lifecycle-sigint-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-sigint-test",
        acpSessionId: "lifecycle-sigint-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);

      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const payload = JSON.stringify({
        sessionId: record.acpxRecordId,
        permissionMode: "approve-reads",
      });

      const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], {
        env: {
          ...process.env,
          HOME: homeDir,
          ACPX_QUEUE_OWNER_PAYLOAD: payload,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      try {
        // Wait for the socket — signal handlers are live at this point.
        await waitUntil(() => fileExists(socketPath));

        child.kill("SIGINT");

        const { code, signal } = await waitForProcessExit(child);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        assert.equal(
          signal,
          null,
          `process should not have been killed by a signal; stderr=${stderr}`,
        );
        assert.equal(code, 0, `expected exit code 0 (graceful); stderr=${stderr}`);

        assert.equal(
          await fileExists(lockPath),
          false,
          "lock file must be gone after graceful shutdown — lease was not released",
        );
      } finally {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });

  it("does not let an idle IPC socket block SIGTERM shutdown or lease release", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempHome("acpx-lifecycle-idle-socket-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-idle-socket-test",
        acpSessionId: "lifecycle-idle-socket-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);
      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], {
        env: {
          ...process.env,
          HOME: homeDir,
          ACPX_QUEUE_OWNER_PAYLOAD: JSON.stringify({
            sessionId: record.acpxRecordId,
            permissionMode: "approve-reads",
          }),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      let idleSocket: net.Socket | undefined;

      try {
        await waitUntil(() => fileExists(socketPath));
        idleSocket = await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(socketPath);
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        });

        child.kill("SIGTERM");
        const { code, signal } = await waitForProcessExit(child, 5_000);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        assert.equal(signal, null, `queue owner should exit gracefully; stderr=${stderr}`);
        assert.equal(code, 0, `expected queue owner exit code 0; stderr=${stderr}`);
        assert.equal(await fileExists(lockPath), false, "lease must be released after shutdown");
      } finally {
        idleSocket?.destroy();
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });
});

describe("queue owner lifecycle — bridge process death on SIGTERM", () => {
  // Verifies that when the queue owner is SIGTERMed while a prompt is in
  // flight, the agent bridge process (mock-agent) is also killed by the
  // queue owner's graceful shutdown before it exits.
  //
  // This test catches the race that existed before the SIGTERM grace-period
  // fix: terminateProcess() used a 1 500 ms SIGTERM grace, but AcpClient.close()
  // can take up to ~2 600 ms.  With the old grace the queue owner could be
  // SIGKILLed before it finished killing the bridge, leaving it orphaned.
  it("kills the agent bridge when the queue owner receives SIGTERM mid-prompt", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempHome("acpx-lifecycle-bridge-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      // PID file: mock-agent writes its PID here as soon as it starts, before
      // the ACP handshake.  We poll for it to know the bridge is live.
      const pidFilePath = path.join(homeDir, "mock-agent.pid");

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-bridge-test",
        acpSessionId: "lifecycle-bridge-session",
        // Pass --pid-file so the bridge records its PID at startup.
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --pid-file ${JSON.stringify(pidFilePath)}`,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const payload = JSON.stringify({
        sessionId: record.acpxRecordId,
        permissionMode: "approve-reads",
      });

      const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], {
        env: {
          ...process.env,
          HOME: homeDir,
          ACPX_QUEUE_OWNER_PAYLOAD: payload,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      let queueSocket: net.Socket | undefined;

      try {
        // Wait for the queue owner socket — signal handlers are live at this point.
        await waitUntil(() => fileExists(socketPath));

        // Connect to the queue-owner socket and submit a long-running prompt.
        // "sleep 10000" keeps the bridge busy for 10 s so it is still alive
        // when we send SIGTERM to the queue owner.
        queueSocket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.setEncoding("utf8");
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });

        queueSocket.write(
          `${JSON.stringify({
            type: "submit_prompt",
            requestId: "req-bridge-test",
            message: "sleep 10000",
            permissionMode: "approve-reads",
            waitForCompletion: true,
          })}\n`,
        );

        // Read the "accepted" acknowledgement.
        const lines = readline.createInterface({ input: queueSocket });
        const iter = lines[Symbol.asyncIterator]();
        const acceptedRaw = await Promise.race([
          iter.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout waiting for accepted")), 5_000),
          ),
        ]);
        const accepted = JSON.parse((acceptedRaw as IteratorYieldResult<string>).value) as {
          type: string;
        };
        assert.equal(accepted.type, "accepted", "queue owner must acknowledge the prompt");

        // Close the readline and socket before sending SIGTERM.
        // (This was previously required to prevent a deadlock — server.close()
        // waited for connected sockets to drain — but is now just one of two
        // test scenarios; the companion test verifies the fix when the socket
        // stays open.)
        lines.close();
        queueSocket.destroy();
        queueSocket = undefined;

        // Wait for the bridge to write its PID — this confirms the bridge
        // process has been spawned and the ACP handshake has started.
        await waitUntil(() => fileExists(pidFilePath), 8_000);

        const bridgePidRaw = (await fs.readFile(pidFilePath, "utf8")).trim();
        const bridgePid = Number(bridgePidRaw);
        assert(
          Number.isInteger(bridgePid) && bridgePid > 0,
          "bridge PID must be a positive integer",
        );
        assert.equal(isProcessAlive(bridgePid), true, "bridge must be alive before SIGTERM");

        // Signal the queue owner to shut down gracefully.
        child.kill("SIGTERM");

        const { code, signal } = await waitForProcessExit(child, 10_000);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        assert.equal(
          signal,
          null,
          `queue owner should not have been killed by a signal; stderr=${stderr}`,
        );
        assert.equal(code, 0, `expected queue owner exit code 0 (graceful); stderr=${stderr}`);

        // After the queue owner exits, the bridge must also be dead.
        // AcpClient.close() kills the bridge before releasing the lease.
        assert.equal(
          isProcessAlive(bridgePid),
          false,
          "bridge process must be dead after queue owner graceful shutdown — was it orphaned?",
        );
      } finally {
        queueSocket?.destroy();
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });

  it("drains the active turn before releasing its lease on SIGTERM", async () => {
    // Regression test for the connected-client deadlock.
    //
    // Before the fix:
    //   closeQueueOwnerRuntime called owner.close() first, which called
    //   server.close().  server.close() waits for all existing connections to
    //   drain.  A client in waitForCompletion that never closed its socket
    //   kept the drain blocked past the external 4 s SIGKILL grace period;
    //   terminateProcess() then SIGKILLed the owner before sharedClient.close()
    //   ran — leaving the bridge orphaned.
    //
    // After the fix, the owner stops admission, cancels and drains the active
    // turn while retaining its lease, then kills the bridge and drains IPC.
    if (process.platform === "win32") {
      return;
    }

    await withTempHome("acpx-lifecycle-bridge-open-socket-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      const pidFilePath = path.join(homeDir, "mock-agent-open.pid");

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-bridge-open-socket-test",
        acpSessionId: "lifecycle-bridge-open-socket-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --pid-file ${JSON.stringify(pidFilePath)} --cancel-delay-ms 500`,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);
      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);

      const payload = JSON.stringify({
        sessionId: record.acpxRecordId,
        permissionMode: "approve-reads",
      });

      const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], {
        env: {
          ...process.env,
          HOME: homeDir,
          ACPX_QUEUE_OWNER_PAYLOAD: payload,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      // This socket intentionally stays open (not destroyed before SIGTERM)
      // to reproduce the deadlock that existed before the fix.
      let queueSocket: net.Socket | undefined;

      try {
        await waitUntil(() => fileExists(socketPath));

        queueSocket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.setEncoding("utf8");
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });

        queueSocket.write(
          `${JSON.stringify({
            type: "submit_prompt",
            requestId: "req-open-socket-test",
            message: "sleep 10000",
            permissionMode: "approve-reads",
            waitForCompletion: true,
          })}\n`,
        );

        // Read the "accepted" acknowledgement.
        const lines = readline.createInterface({ input: queueSocket });
        const iter = lines[Symbol.asyncIterator]();
        const acceptedRaw = await Promise.race([
          iter.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout waiting for accepted")), 5_000),
          ),
        ]);
        const accepted = JSON.parse((acceptedRaw as IteratorYieldResult<string>).value) as {
          type: string;
        };
        assert.equal(accepted.type, "accepted", "queue owner must acknowledge the prompt");

        // Deliberately do NOT close the readline or socket here.
        // The fix must handle this — the socket remaining open must not block
        // the bridge kill or prevent the owner from exiting within the grace period.

        // Wait until the bridge has written its PID — ACP handshake started.
        await waitUntil(() => fileExists(pidFilePath), 8_000);

        const bridgePidRaw = (await fs.readFile(pidFilePath, "utf8")).trim();
        const bridgePid = Number(bridgePidRaw);
        assert(
          Number.isInteger(bridgePid) && bridgePid > 0,
          "bridge PID must be a positive integer",
        );
        assert.equal(isProcessAlive(bridgePid), true, "bridge must be alive before SIGTERM");

        // Delay session/cancel in the mock so the lease-retention assertion is
        // deterministic while the active turn is still unwinding.
        child.kill("SIGTERM");

        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        const leaseHeldDuringCancel = await fileExists(lockPath);
        assert.equal(
          leaseHeldDuringCancel,
          true,
          "lease must remain held until active turn cancellation completes",
        );

        const terminalMessage = await waitForTerminalQueueMessage(iter, 5_000);
        assert.equal(terminalMessage.type, "result");
        const clientResult = terminalMessage.result as { stopReason?: unknown };
        assert.equal(clientResult.stopReason, "cancelled");

        // Tight budget: the owner must finish within the external grace even
        // though the client socket remained connected until its typed result.
        const { code, signal } = await waitForProcessExit(child, 8_000);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        assert.equal(
          signal,
          null,
          `queue owner should not have been killed by a signal — it likely stalled past the grace period; stderr=${stderr}`,
        );
        assert.equal(code, 0, `expected queue owner exit code 0 (graceful); stderr=${stderr}`);

        // Bridge must be dead — it must not have been orphaned.
        assert.equal(
          isProcessAlive(bridgePid),
          false,
          "bridge process must be dead after queue owner graceful shutdown — was it orphaned? (connected-client deadlock regression)",
        );

        // Lock file must be released.
        const leaseReleased = !(await fileExists(lockPath));
        assert.equal(leaseReleased, true, "lock file must be gone after graceful shutdown");

        if (process.env.ACPX_TEST_LIFECYCLE_TRACE === "1") {
          process.stdout.write(
            `ACPX_LIFECYCLE_PROOF ${JSON.stringify({
              ownerPid: child.pid,
              ownerExitCode: code,
              ownerSignal: signal,
              bridgePid,
              bridgeAliveAfter: isProcessAlive(bridgePid),
              leaseHeldDuringCancel,
              leaseReleased,
              clientType: terminalMessage.type,
              clientStopReason: clientResult.stopReason,
            })}\n`,
          );
        }

        lines.close();
      } finally {
        queueSocket?.destroy();
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });
});
