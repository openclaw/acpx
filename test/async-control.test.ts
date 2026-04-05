import assert from "node:assert/strict";
import test from "node:test";
import {
  InterruptedError,
  TimeoutError,
  withInterrupt,
  withTimeout,
} from "../src/async-control.js";

test("withTimeout resolves when timeout is disabled", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 0);
  assert.equal(result, "ok");
});

test("withTimeout rejects with TimeoutError when promise takes too long", async () => {
  const never = new Promise<string>(() => {});

  await assert.rejects(
    async () => await withTimeout(never, 10),
    (error: unknown) => {
      assert(error instanceof TimeoutError);
      assert.equal(error.message, "Timed out after 10ms");
      return true;
    },
  );
});

test("withTimeout preserves the original rejection", async () => {
  const expected = new Error("boom");

  await assert.rejects(async () => await withTimeout(Promise.reject(expected), 100), expected);
});

test("withInterrupt resolves normally without invoking interrupt cleanup", async () => {
  let interrupted = false;
  const result = await withInterrupt(
    async () => "done",
    async () => {
      interrupted = true;
    },
  );

  assert.equal(result, "done");
  assert.equal(interrupted, false);
});

test("withInterrupt rejects with InterruptedError on SIGINT and runs cleanup once", async () => {
  let interruptCalls = 0;
  let releaseRun: (() => void) | undefined;

  const pending = withInterrupt(
    async () =>
      await new Promise<string>((resolve) => {
        releaseRun = () => resolve("late");
      }),
    async () => {
      interruptCalls += 1;
    },
  );

  process.emit("SIGINT");
  process.emit("SIGINT");

  await assert.rejects(async () => await pending, InterruptedError);
  assert.equal(interruptCalls, 1);

  releaseRun?.();
});

test("withInterrupt rejects with InterruptedError on SIGTERM and removes signal listeners", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const sighupBefore = process.listenerCount("SIGHUP");

  const pending = withInterrupt(
    async () => await new Promise<string>(() => {}),
    async () => {},
  );

  assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1);
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1);
  assert.equal(process.listenerCount("SIGHUP"), sighupBefore + 1);

  process.emit("SIGTERM");

  await assert.rejects(async () => await pending, InterruptedError);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
  assert.equal(process.listenerCount("SIGHUP"), sighupBefore);
});

test("withInterrupt rejects with InterruptedError on SIGHUP", async () => {
  let interruptCalls = 0;

  const pending = withInterrupt(
    async () => await new Promise<string>(() => {}),
    async () => {
      interruptCalls += 1;
    },
  );

  process.emit("SIGHUP");

  await assert.rejects(async () => await pending, InterruptedError);
  assert.equal(interruptCalls, 1);
});
