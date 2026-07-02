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
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
  // Implementation note: doShutdown() uses a shared Promise (not a boolean
  // flag) so that both the signal handler (withInterrupt's onInterrupt
  // callback) and the finally block await the SAME cleanup.  With a boolean
  // flag the finally block would return immediately while cleanup was still
  // in progress, causing runSessionQueueOwner to return before
  // releaseQueueOwnerLease executed (floating promise / orphaned lock file).
  // The tests below verify the lock file is gone synchronously after process
  // exit, which only holds if both callers fully awaited cleanup.

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
      // The socket file is created inside withInterrupt's `run()` callback
      // (by SessionQueueOwner.start()), which executes AFTER withInterrupt has
      // installed SIGTERM/SIGINT/SIGHUP handlers.  Waiting for the socket
      // avoids the race where the lock file exists but handlers aren't yet live.
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
        // Wait until the queue owner has created its Unix socket — at this
        // point SessionQueueOwner.start() has returned, meaning withInterrupt
        // has already installed the signal handlers and we're inside nextTask().
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

  it("releases lease even when doShutdown is invoked concurrently from signal and finally block", async () => {
    // Regression test for the shared-promise fix.
    //
    // SIGTERM fires while the queue owner is in nextTask().  withInterrupt's
    // onInterrupt callback calls doShutdown() (first invocation), which
    // starts closeQueueOwnerRuntime().  The resulting InterruptedError is
    // then caught, the finally block runs, and it calls doShutdown() again
    // (second invocation).
    //
    // With the old boolean guard the second invocation returned immediately
    // without awaiting the in-progress cleanup.  runSessionQueueOwner could
    // therefore return before releaseQueueOwnerLease had run, leaving the
    // lock file on disk.
    //
    // With the shared-promise fix both invocations await the same Promise,
    // so the process only exits after cleanup is fully complete.
    if (process.platform === "win32") {
      return;
    }

    await withTempHome("acpx-lifecycle-concurrent-shutdown-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-concurrent-shutdown-test",
        acpSessionId: "lifecycle-concurrent-shutdown-session",
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
        // Wait until the owner is inside nextTask() — signal handlers live.
        await waitUntil(() => fileExists(socketPath));

        assert.equal(await fileExists(lockPath), true, "lock file must exist before SIGTERM");

        // Send SIGTERM — this triggers the concurrent doShutdown scenario.
        child.kill("SIGTERM");

        const { code, signal } = await waitForProcessExit(child);
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        assert.equal(
          signal,
          null,
          `process should not have been killed by a signal; stderr=${stderr}`,
        );
        assert.equal(code, 0, `expected exit code 0 (graceful); stderr=${stderr}`);

        // Lock file must be gone immediately after process exit — not
        // eventually.  A floating cleanup promise would leave it on disk.
        assert.equal(
          await fileExists(lockPath),
          false,
          "lock file must be gone after graceful shutdown — shared shutdown promise was not awaited",
        );
      } finally {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    });
  });
});
