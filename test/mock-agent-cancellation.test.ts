import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { CancelledError, sleepWithCancel } from "./mock-agent-cancellation.js";

test("mock sleeps release their abort listener after each completed poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const unrelatedListener = t.mock.fn();
  controller.signal.addEventListener("abort", unrelatedListener);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sleeping = sleepWithCancel(10, controller.signal);
    t.mock.timers.tick(10);
    await sleeping;
    assert.deepEqual(getEventListeners(controller.signal, "abort"), [unrelatedListener]);
  }

  controller.abort();
  assert.equal(unrelatedListener.mock.callCount(), 1);
});

test("cancelling a mock sleep removes its listener and clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const controller = new AbortController();
  const rejected = assert.rejects(sleepWithCancel(1_000, controller.signal), CancelledError);

  controller.abort();
  await rejected;

  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  assert.equal(clearTimer.mock.callCount(), 1);
});

test("an already-cancelled mock sleep creates no timer or listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const startTimer = t.mock.method(globalThis, "setTimeout");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(sleepWithCancel(10, controller.signal), CancelledError);

  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  assert.equal(startTimer.mock.callCount(), 0);
});
