import assert from "node:assert/strict";
import test from "node:test";
import { LiveSessionCheckpoint } from "../src/session/live-checkpoint.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a rejected checkpoint leaves its state available to the next explicit flush", async () => {
  const failure = new Error("transient save failure");
  const saved: string[] = [];
  let attempts = 0;
  const checkpoint = new LiveSessionCheckpoint({
    save: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
      saved.push("pending update");
    },
  });
  await assert.rejects(checkpoint.checkpoint(), (error) => error === failure);
  assert.equal(attempts, 1);
  await checkpoint.flush();
  assert.deepEqual(saved, ["pending update"]);
  await checkpoint.flush();
  assert.equal(attempts, 2);
});

test("permanent save failure rejects each explicit flush without retrying itself", async () => {
  const failure = new Error("persistent save failure");
  let attempts = 0;
  const checkpoint = new LiveSessionCheckpoint({
    save: async () => {
      attempts += 1;
      throw failure;
    },
  });
  await assert.rejects(checkpoint.checkpoint(), (error) => error === failure);
  for (let expected = 2; expected <= 3; expected += 1) {
    await assert.rejects(checkpoint.flush(), (error) => error === failure);
    assert.equal(attempts, expected);
  }
});

test("concurrent flush callers share failure and a later flush retries once", async () => {
  const entered = deferred();
  const release = deferred();
  const failure = new Error("shared save failure");
  let attempts = 0;
  const checkpoint = new LiveSessionCheckpoint({
    save: async () => {
      attempts += 1;
      if (attempts === 1) {
        entered.resolve();
        await release.promise;
        throw failure;
      }
    },
  });
  const first = checkpoint.checkpoint();
  await entered.promise;
  const results = Promise.allSettled([first, checkpoint.flush()]);
  release.resolve();
  assert.deepEqual(await results, [
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  assert.equal(attempts, 1);
  await checkpoint.flush();
  await checkpoint.flush();
  assert.equal(attempts, 2);
});

test("a failed timer checkpoint remains pending for an explicit flush", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed = deferred();
  const failure = new Error("timer save failure");
  const errors: unknown[] = [];
  let attempts = 0;
  const checkpoint = new LiveSessionCheckpoint({
    intervalMs: 10,
    save: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
    },
    onError(error) {
      errors.push(error);
      observed.resolve();
    },
  });
  checkpoint.request();
  t.mock.timers.tick(10);
  await observed.promise;
  assert.deepEqual(errors, [failure]);
  t.mock.timers.tick(1000);
  assert.equal(attempts, 1);
  await checkpoint.flush();
  assert.equal(attempts, 2);
  await checkpoint.flush();
  assert.equal(attempts, 2);
});

for (const failFirst of [false, true]) {
  test(`updates arriving during ${failFirst ? "failed" : "successful"} saves remain pending`, async () => {
    const entered = deferred();
    const release = deferred();
    const failure = new Error("save interrupted by failure");
    const saved: number[] = [];
    let current = 1;
    let attempts = 0;
    const checkpoint = new LiveSessionCheckpoint({
      save: async () => {
        const snapshot = current;
        attempts += 1;
        if (attempts === 1) {
          entered.resolve();
          await release.promise;
          if (failFirst) {
            throw failure;
          }
        }
        saved.push(snapshot);
      },
    });
    const pending = checkpoint.checkpoint();
    await entered.promise;
    current = 2;
    checkpoint.request();
    const settled = Promise.allSettled([pending]);
    release.resolve();
    assert.deepEqual(
      await settled,
      failFirst
        ? [{ status: "rejected", reason: failure }]
        : [{ status: "fulfilled", value: undefined }],
    );
    await checkpoint.flush();
    assert.deepEqual(saved, failFirst ? [2] : [1, 2]);
    assert.equal(attempts, 2);
  });
}
