import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "../src/async-control.js";
import {
  QueueControlDeadline,
  QueueOwnerControlAdmission,
  type QueueOwnerControlMethods,
} from "../src/session/queue/control-admission.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function methods(): QueueOwnerControlMethods {
  return {
    setSessionMode: async () => {},
    setSessionModel: async () => undefined,
    setSessionConfigOption: async () => ({ configOptions: [] }),
  };
}

function admission(idle: QueueOwnerControlMethods) {
  return new QueueOwnerControlAdmission({
    runIdle: async (invoke, options) => await invoke(idle, options.deadline),
  });
}

test("starting controls wait for their prompt context without allocating an idle connection", async () => {
  const idle = methods(),
    active = methods();
  const controls = admission(idle);
  const { ticket, priorIdle } = controls.beginPrompt();
  let invoked = false;
  const operation = controls.run(async (context) => {
    invoked = true;
    assert.equal(context, active);
  });
  await priorIdle;
  await Promise.resolve();
  assert.equal(invoked, false);
  controls.publish(ticket, active);
  await operation;
  await controls.seal(ticket);
  controls.release(ticket);
});

test("idle controls keep their target when a prompt is selected behind them", async () => {
  const idle = methods(),
    active = methods(),
    releaseIdle = deferred<void>();
  const controls = admission(idle);
  const idleOperation = controls.run(async (context) => {
    assert.equal(context, idle);
    await releaseIdle.promise;
  });
  const { ticket, priorIdle } = controls.beginPrompt();
  const starting = controls.run(async (context) => assert.equal(context, active));
  releaseIdle.resolve();
  await withTimeout(priorIdle, 1000);
  controls.publish(ticket, active);
  await Promise.all([idleOperation, starting]);
  await controls.seal(ticket);
  controls.release(ticket);
});

test("controls admitted after sealing do not join the drain that holds their next lock", async () => {
  const idle = methods(),
    active = methods(),
    releaseActive = deferred<void>();
  const controls = admission(idle);
  const { ticket } = controls.beginPrompt();
  controls.publish(ticket, active);
  const operation = controls.run(async (context) => {
    assert.equal(context, active);
    await releaseActive.promise;
  });
  const draining = controls.seal(ticket);
  let nextRan = false;
  const next = controls.run(async (context) => {
    assert.equal(context, idle);
    nextRan = true;
  });
  releaseActive.resolve();
  await withTimeout(draining, 1000);
  assert.equal(nextRan, false);
  controls.release(ticket);
  await Promise.all([operation, next]);
  assert.equal(nextRan, true);
});

test("an unready prompt failure rejects its admitted controls without deadlocking cleanup", async () => {
  const controls = admission(methods());
  const { ticket } = controls.beginPrompt();
  let invoked = false;
  const operation = controls.run(async () => {
    invoked = true;
  });
  const rejected = assert.rejects(operation, /ended before controls became ready/);
  await withTimeout(controls.seal(ticket), 1000);
  controls.release(ticket);
  await rejected;
  assert.equal(invoked, false);
});

test("a queued control deadline prevents later invocation and does not cancel its predecessor", async () => {
  const controls = admission(methods()),
    release = deferred<void>();
  const first = controls.run(async (_context, deadline) => {
    await release.promise;
    assert.equal(deadline.signal.aborted, false);
  });
  let invoked = false;
  const expired = controls.run(async () => {
    invoked = true;
  }, 20);
  await assert.rejects(expired, /Timed out after 20ms/);
  assert.equal(controls.hasPending, true);
  release.resolve();
  await first;
  await controls.drainAdmitted();
  assert.equal(invoked, false);
});

test("closing rejects new and queued controls while draining already invoked work", async () => {
  const controls = admission(methods()),
    release = deferred<void>(),
    started = deferred<void>();
  const first = controls.run(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let queuedRan = false;
  const queued = controls.run(async () => {
    queuedRan = true;
  });
  controls.stopAdmission();
  await assert.rejects(
    controls.run(async () => {}),
    { detailCode: "QUEUE_OWNER_SHUTTING_DOWN" },
  );
  const rejected = assert.rejects(queued, { detailCode: "QUEUE_OWNER_SHUTTING_DOWN" });
  release.resolve();
  await Promise.all([first, rejected, controls.drainAdmitted()]);
  assert.equal(queuedRan, false);
});

test("native settlement clears the deadline before durable checkpoint work", async () => {
  const deadline = new QueueControlDeadline(20);
  const checkpoint = deferred<string>();
  deadline.responseSettled();
  const result = deadline.wait(checkpoint.promise);
  await delay(35);
  assert.equal(deadline.signal.aborted, false);
  checkpoint.resolve("saved");
  assert.equal(await result, "saved");
});
