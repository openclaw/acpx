import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSessionQueueOwner } from "../src/session/execution/queue-owner-runtime.js";
import { SessionQueueOwner } from "../src/session/queue/ipc-server.js";
import {
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  readQueueOwnerRecord,
} from "../src/session/queue/lease-store.js";
import { queueLockFilePath, queueSocketPath } from "../src/session/queue/paths.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const FIXTURE = fileURLToPath(new URL("./fixtures/queue-owner-stop-phase.js", import.meta.url));
const listeners = () => SIGNALS.map((signal) => process.rawListeners(signal));
type Message = { type: string; token?: number; [key: string]: unknown };

async function within<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function capture(stream: Readable) {
  const chunks: Buffer[] = [];
  let eof = false;
  let error: Error | undefined;
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  stream.once("end", () => {
    eof = true;
  });
  stream.once("error", (value: Error) => {
    error = value;
  });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  return { closed, result: () => ({ eof, error, text: Buffer.concat(chunks).toString("utf8") }) };
}

function ownFixture(home: string, phase: string) {
  const child = spawn(process.execPath, [FIXTURE, home, phase], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert(child.stdout && child.stderr);
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  let spawnError: Error | undefined;
  let exited = false;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const messages: Message[] = [];
  child.on("message", (raw: unknown) => {
    if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string") {
      messages.push(raw as Message);
    }
  });
  const message = async (type: string, token?: number): Promise<Message> => {
    const existing = messages.find((entry) => entry.type === type && entry.token === token);
    if (existing) {
      return existing;
    }
    let changed!: (raw: unknown) => void;
    try {
      const received = new Promise<Message>((resolve) => {
        changed = (raw) => {
          if (
            raw &&
            typeof raw === "object" &&
            "type" in raw &&
            raw.type === type &&
            (token === undefined || ("token" in raw && raw.token === token))
          ) {
            resolve(raw as Message);
          }
        };
        child.on("message", changed);
      });
      return await within(
        Promise.race([
          received,
          closed.then(() => {
            throw new Error(`Owner exited before ${type}: ${stderr.result().text}`);
          }),
        ]),
        type,
      );
    } finally {
      child.off("message", changed);
    }
  };
  const send = async (value: Message) => {
    await new Promise<void>((resolve, reject) =>
      child.send(value, (error) => (error ? reject(error) : resolve())),
    );
  };
  const collect = async () => {
    const result = await within(closed, "owner close");
    await within(Promise.all([stdout.closed, stderr.closed]), "owner PIPE close");
    return { ...result, stdout: stdout.result(), stderr: stderr.result(), spawnError };
  };
  const cleanup = async () => {
    if (!exited && child.connected) {
      await send({ type: "release" }).catch(() => {});
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    try {
      return await collect();
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await collect();
      throw new Error("Owned fixture required forced cleanup; never a normal proof pass", {
        cause: error,
      });
    }
  };
  return {
    child,
    message,
    send,
    collect,
    cleanup,
    isJoined: () => exited && stdout.result().eof && stderr.result().eof,
  };
}

for (const phase of ["acquisition", "shutdown", "release"] as const) {
  test(
    `queue owner handles repeated SIGTERM while ${phase} is held`,
    { skip: process.platform === "win32", timeout: 20_000 },
    async (t) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stop-phase-"));
      const fixture = ownFixture(home, phase);
      let failure: { error: unknown } | undefined;
      try {
        if (phase !== "acquisition") {
          await fixture.message("ready");
          assert(fixture.child.kill("SIGTERM"), "initial owned stop was dispatched");
        }
        const entered = await fixture.message("phase");
        if (phase !== "shutdown") {
          assert.equal(entered.guardPresent, true, "the exact mutation guard remains held");
        }
        const before = entered.beforeCounts as Record<string, number>;
        for (const token of [1, 2]) {
          assert(fixture.child.kill("SIGTERM"), "stop during held phase was dispatched");
          await fixture.send({ type: "probe", token });
          const probe = await fixture.message("probe", token);
          assert.equal(probe.held, true);
          const current = probe.counts as Record<string, number>;
          for (const signal of SIGNALS) {
            assert.equal(current[signal], before[signal] + 1, signal);
          }
        }
        await fixture.send({ type: "release" });
        const done = await fixture.message("done");
        const outcome = await fixture.collect();
        assert.equal(outcome.spawnError, undefined);
        assert.equal(outcome.signal, null, outcome.stderr.text);
        assert.equal(outcome.code, 0, outcome.stderr.text);
        for (const stream of [outcome.stdout, outcome.stderr]) {
          assert(stream.eof);
          assert.equal(stream.error, undefined);
        }
        assert.deepEqual(done.counts, done.beforeCounts);
        assert.equal(done.closeCalls, 1, "repeated requests share owned client cleanup");
        assert.equal(done.leaseUnlinks, 1, "outer lease release is not re-entered");
        assert.equal(done.leasePresent, false);
        assert.equal(done.guardPresent, false);
      } catch (error) {
        failure = { error };
      }
      try {
        await fixture.cleanup();
      } catch (error) {
        failure = {
          error: failure
            ? new AggregateError([failure.error, error], "Assertion and owned-child cleanup failed")
            : error,
        };
      }
      try {
        if (fixture.isJoined()) {
          const socket = queueSocketPath(`stop-phase-${phase}`, home);
          await fs.unlink(socket).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          });
          await fs.rm(home, { recursive: true, force: true });
        } else {
          t.diagnostic(`Retained unjoined fixture state: ${home}`);
        }
      } catch (error) {
        failure = {
          error: failure
            ? new AggregateError([failure.error, error], "Assertion and scratch cleanup failed")
            : error,
        };
      }
      if (failure) {
        throw failure.error;
      }
    },
  );
}

function removeNewListeners(before: ReturnType<typeof listeners>): void {
  for (const [index, signal] of SIGNALS.entries()) {
    for (const current of process.rawListeners(signal)) {
      if (!before[index].includes(current)) {
        process.off(signal, current);
      }
    }
  }
}

test("queue owner restores listeners when another live lease is selected", async () => {
  await withTempHome("acpx-stop-no-lease-", async (home) => {
    const id = "stop-no-lease";
    const lease = await tryAcquireQueueOwnerLease(id);
    assert(lease);
    const before = listeners();
    try {
      await runSessionQueueOwner({ sessionId: id, permissionMode: "deny-all" });
      assert.deepEqual(listeners(), before);
      assert.equal((await readQueueOwnerRecord(id))?.ownerGeneration, lease.ownerGeneration);
    } finally {
      removeNewListeners(before);
      await releaseQueueOwnerLease(lease);
      await assert.rejects(fs.access(queueLockFilePath(id, home)), { code: "ENOENT" });
    }
  });
});

for (const scenario of ["setup", "release", "both"] as const) {
  test(`queue owner restores listeners and preserves ${scenario} failure`, async (t) => {
    await withTempHome("acpx-stop-failure-", async (home) => {
      const id = `stop-${scenario}`;
      await writeSessionRecordFile(
        home,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "unused-stop-agent",
          cwd: home,
        }),
      );
      const lock = queueLockFilePath(id, home);
      const sessionDirectory = path.join(home, ".acpx/sessions");
      await fs.mkdir(path.dirname(lock), { recursive: true });
      const lockPaths = new Set([
        lock,
        path.join(await fs.realpath(path.dirname(lock)), path.basename(lock)),
      ]);
      const sessionDirectories = new Set([sessionDirectory, await fs.realpath(sessionDirectory)]);
      const setupError = new Error("exact setup failure");
      const releaseError = new Error("exact release failure");
      const before = listeners();
      let protectedSetup = false;
      let protectedRelease = false;
      const protectedNow = () =>
        listeners().every(
          (current, index) =>
            current.length === before[index].length + 1 &&
            before[index].every((listener) => current.includes(listener)),
        );
      const mkdir = fs.mkdir;
      const unlink = fs.unlink;
      t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
        if (sessionDirectories.has(path.resolve(String(args[0]))) && scenario !== "release") {
          protectedSetup = protectedNow();
          throw setupError;
        }
        return await mkdir(...args);
      });
      t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
        if (lockPaths.has(path.resolve(String(args[0]))) && scenario !== "setup") {
          protectedRelease = protectedNow();
          throw releaseError;
        }
        return await unlink(...args);
      });
      t.mock.method(SessionQueueOwner.prototype, "nextTask", async () => undefined);
      try {
        await assert.rejects(
          runSessionQueueOwner({ sessionId: id, permissionMode: "deny-all" }),
          (error: unknown) => {
            if (scenario === "both") {
              assert(error instanceof AggregateError);
              assert.deepEqual(error.errors, [setupError, releaseError]);
              assert.equal(error.errors[0], setupError);
              assert.equal(error.errors[1], releaseError);
              assert.equal(error.cause, releaseError);
              assert.equal(error.message, "Queue owner shutdown failed");
            } else {
              assert.equal(error, scenario === "setup" ? setupError : releaseError);
            }
            return true;
          },
        );
        assert.deepEqual(listeners(), before);
        if (scenario !== "release") {
          assert(protectedSetup, "setup remains signal-protected");
        }
        if (scenario !== "setup") {
          assert(protectedRelease, "release remains signal-protected");
        }
      } finally {
        t.mock.restoreAll();
        removeNewListeners(before);
        // The owner invocation has settled. Remove only this test's retained lease.
        const retained = await readQueueOwnerRecord(id);
        if (retained) {
          assert.equal(retained.pid, process.pid);
          assert.equal(retained.sessionId, id);
          await fs.unlink(lock);
        }
      }
    });
  });
}
