import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTimeout } from "../src/async-control.js";
import { withQueueLeaseMutation } from "../src/session/queue/lease-mutation.js";
import { queueLockFilePath } from "../src/session/queue/paths.js";
import { withTempHome } from "./queue-test-helpers.js";

const HOLDER = `
const { withQueueLeaseMutation } = await import(process.argv[1]);
let release;
const released = new Promise(resolve => { release = resolve; });
process.on('message', message => { if (message === 'release') release(); });
process.on('disconnect', () => release());
const watchdog = setTimeout(() => { process.exitCode = 2; release(); }, 15_000);
try {
  await withQueueLeaseMutation(process.argv[2], async () => {
    process.send({ pid: process.pid });
    await released;
  });
} finally {
  clearTimeout(watchdog);
  if (process.connected) process.disconnect();
}
`;

test("queue guard contention survives a forward wall-clock step without replacing its holder", async (t) => {
  await withTempHome(async () => {
    const id = "clock-step-guard";
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        HOLDER,
        new URL("../src/session/queue/lease-mutation.js", import.meta.url).href,
        id,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const closed = once(child, "close");
    void closed.catch(() => {});
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    const errors: unknown[] = [];
    let guardPath: string | undefined;
    let heldBytes: Buffer | undefined;
    let settled: Promise<unknown> | undefined;
    const result: { error?: unknown; entered: number } = { entered: 0 };
    let attempts = 0;
    let forced = false;
    let holderPreserved = false;
    try {
      const [ready] = await withTimeout(
        Promise.race([
          once(child, "message"),
          closed.then(() => {
            throw new Error(`Guard holder exited before readiness: ${stderr}`);
          }),
        ]),
        5_000,
      );
      assert.deepEqual(ready, { pid: child.pid });
      const requested = queueLockFilePath(id);
      guardPath =
        path.join(await fs.realpath(path.dirname(requested)), path.basename(requested)) + ".guard";
      heldBytes = await fs.readFile(guardPath);
      let retried!: () => void;
      const retryObserved = new Promise<void>((resolve) => {
        retried = resolve;
      });
      const now = Date.now;
      let clockOffset = 0;
      t.mock.method(Date, "now", () => now() + clockOffset);
      const lstat = fsSync.lstatSync;
      t.mock.method(fsSync, "lstatSync", (...args: Parameters<typeof lstat>) => {
        // Both dependency versions inspect this path after starting the deadline
        // and before each real exclusive-open attempt. Only the wall clock moves.
        if (String(args[0]) === `${guardPath}.reclaim`) {
          attempts += 1;
          clockOffset = 60_000;
          if (attempts === 2) {
            retried();
          }
        }
        return lstat(...args);
      });
      settled = withQueueLeaseMutation(id, async () => {
        result.entered += 1;
      }).catch((error: unknown) => {
        result.error = error;
      });
      const observedRetry = await withTimeout(
        Promise.race([retryObserved.then(() => true), settled.then(() => false)]),
        5_000,
      );
      assert.equal(
        observedRetry,
        true,
        "queue guard exhausted its wait after only a wall-clock step",
      );
      assert.equal(result.entered, 0, "the live holder still owns exclusion");
    } catch (error) {
      errors.push(error);
    } finally {
      t.mock.restoreAll();
      try {
        if (heldBytes && guardPath) {
          assert.deepEqual(await fs.readFile(guardPath), heldBytes);
          assert.equal(child.exitCode, null);
          assert.equal(child.signalCode, null);
          holderPreserved = true;
        }
      } catch (error) {
        errors.push(error);
      }
      if (child.connected) {
        child.send("release", () => {});
      }
      try {
        assert.deepEqual(await withTimeout(closed, 5_000), [0, null], stderr);
      } catch (error) {
        errors.push(error);
        if (child.exitCode === null && child.signalCode === null) {
          forced = child.kill("SIGKILL");
        }
        await withTimeout(closed, 5_000).catch((cleanupError: unknown) =>
          errors.push(cleanupError),
        );
      }
      await withTimeout(settled ?? Promise.resolve(), 5_000).catch((error: unknown) =>
        errors.push(error),
      );
      process.stdout.write(
        `QUEUE_GUARD_CLOCK ${JSON.stringify({ pid: child.pid, attempts, holderPreserved, entered: result.entered, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code, childClosed: child.exitCode !== null || child.signalCode !== null, forced })}\n`,
      );
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Guard clock fixture and cleanup failed");
    }
    assert.equal(result.error, undefined);
    assert.equal(result.entered, 1);
    assert.ok(guardPath);
    await assert.rejects(fs.access(guardPath), { code: "ENOENT" });
  });
});
