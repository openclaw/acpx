import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { FlowRunner } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import type { FlowSessionBinding } from "../src/flows/types.js";
import type { AcpJsonRpcMessage, AcpMessageDirection } from "../src/types.js";

type PromptCaptureReceipt<T> = {
  outcome: PromiseSettledResult<T>;
  events?: { eventStartSeq: number; eventEndSeq: number };
  lastSeq: number;
};

type Capture = {
  onAcpMessage(direction: AcpMessageDirection, message: AcpJsonRpcMessage): void;
  run<T, F>(
    operation: () => Promise<T>,
    finalize: (receipt: PromptCaptureReceipt<T>) => Promise<F>,
  ): Promise<F>;
};

function createCapture(append: () => Promise<number>): Capture {
  const runner = new FlowRunner({
    permissionMode: "deny-all",
    resolveAgent: () => ({ agentName: "unused", agentCommand: "unused", cwd: process.cwd() }),
  });
  const harness = runner as unknown as {
    store: FlowRunStore;
    createPromptEventCapture(runDir: string, binding: FlowSessionBinding): Capture;
  };
  // A mock call ledger would itself retain promises in the heap assertion.
  harness.store.appendSessionEvent = append;
  return harness.createPromptEventCapture("unused", {
    key: "capture",
    handle: "capture",
    bundleId: "capture",
    name: "capture",
    agentName: "unused",
    agentCommand: "unused",
    cwd: process.cwd(),
    acpxRecordId: "capture",
    acpSessionId: "capture",
  });
}

function emit(capture: Capture): void {
  capture.onAcpMessage("inbound", { jsonrpc: "2.0", method: "session/update", params: {} });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { status: "fulfilled" as const, value };
    },
    (reason: unknown) => {
      settled = true;
      return { status: "rejected" as const, reason };
    },
  );
  return { outcome, settled: () => settled };
}

test("long prompts release settled capture writes before the prompt finishes", async () => {
  class CaptureWrite<T> extends Promise<T> {}
  let seq = 0;
  const capture = createCapture(() => CaptureWrite.resolve(++seq));
  for (let index = 0; index < 512; index += 1) {
    emit(capture);
  }
  await nextTurn();
  const retained = queryObjects(CaptureWrite, { format: "count" });
  const receipt = await capture.run(
    async () => "done",
    async (value) => value,
  );
  assert.ok(retained < 8, `settled capture writes retained during prompt: ${retained}`);
  assert.deepEqual(receipt, {
    outcome: { status: "fulfilled", value: "done" },
    events: { eventStartSeq: 1, eventEndSeq: 512 },
    lastSeq: 512,
  });
});

for (const rejected of [false, true]) {
  test(
    `capture drains writes before finalizing and awaits finalization after ${rejected ? "rejection" : "success"}`,
    { timeout: 5_000 },
    async () => {
      const first = deferred<number>();
      const entered = deferred<void>();
      const release = deferred<void>();
      const finalValue = { finalized: true };
      let index = 0;
      let calls = 0;
      let receipt: PromptCaptureReceipt<string> | undefined;
      const capture = createCapture(() => (++index === 1 ? first.promise : Promise.resolve(9)));
      emit(capture);
      emit(capture);
      const observed = observe(
        capture.run(
          async () => {
            if (rejected) {
              throw undefined;
            }
            return "operation result";
          },
          async (value) => {
            calls += 1;
            receipt = value;
            entered.resolve();
            await release.promise;
            return finalValue;
          },
        ),
      );
      try {
        await nextTurn();
        assert.equal(calls, 0, "a late append must drain before finalization starts");
        assert.equal(observed.settled(), false);
        first.resolve(3);
        await entered.promise;
        assert.equal(calls, 1);
        assert.deepEqual(receipt, {
          outcome: rejected
            ? { status: "rejected", reason: undefined }
            : { status: "fulfilled", value: "operation result" },
          events: { eventStartSeq: 3, eventEndSeq: 9 },
          lastSeq: 9,
        });
        assert.equal(observed.settled(), false, "finalization still owns settlement");
        release.resolve();
        const outcome = await observed.outcome;
        if (rejected) {
          assert.ok(outcome.status === "rejected");
          assert.equal(outcome.reason, undefined);
        } else {
          assert.ok(outcome.status === "fulfilled");
          assert.equal(outcome.value, finalValue, "run must return the finalizer's value");
        }
      } finally {
        first.resolve(3);
        release.resolve();
        await observed.outcome;
      }
    },
  );
}

for (const failOperation of [false, true]) {
  test(
    `capture keeps ${failOperation ? "the prompt rejection" : "the first admitted append failure"} ahead of finalizer failure`,
    { timeout: 5_000 },
    async () => {
      const first = deferred<number>();
      const second = deferred<number>();
      const firstError = new Error("first admitted event failed");
      const secondError = new Error("second event failed sooner");
      const finalizerError = new Error("finalizer failed last");
      const operationError = Object.freeze(new Error("original prompt failure"));
      let index = 0;
      let calls = 0;
      let receipt: PromptCaptureReceipt<string> | undefined;
      const capture = createCapture(() => {
        index += 1;
        return index === 1 ? first.promise : index === 2 ? second.promise : Promise.resolve(12);
      });
      emit(capture);
      emit(capture);
      emit(capture);
      const observed = observe(
        capture.run(
          async () => {
            if (failOperation) {
              throw operationError;
            }
            return "operation succeeded";
          },
          async (value) => {
            calls += 1;
            receipt = value;
            throw finalizerError;
          },
        ),
      );
      try {
        second.reject(secondError);
        await nextTurn();
        assert.equal(calls, 0);
        assert.equal(observed.settled(), false);
        first.reject(firstError);
        const outcome = await observed.outcome;
        assert.ok(outcome.status === "rejected");
        assert.equal(outcome.reason, failOperation ? operationError : firstError);
        assert.equal(calls, 1, "the finalizer must still run after append failures");
        assert.ok(receipt);
        assert.deepEqual(
          receipt.outcome,
          failOperation
            ? { status: "rejected", reason: operationError }
            : { status: "fulfilled", value: "operation succeeded" },
        );
        assert.equal(receipt.events, undefined, "partial writes cannot certify a complete range");
        assert.equal(receipt.lastSeq, 12, "retain the highest successfully persisted sequence");
      } finally {
        first.reject(firstError);
        second.reject(secondError);
        await observed.outcome;
      }
    },
  );
}

test("capture remembers settled append failures and finalizes a zero-write receipt", async () => {
  const error = new Error("journal failed before run");
  const capture = createCapture(() => Promise.reject(error));
  emit(capture);
  await nextTurn();
  let calls = 0;
  let receipt: PromptCaptureReceipt<string> | undefined;
  await assert.rejects(
    capture.run(
      async () => "done",
      async (value) => {
        calls += 1;
        receipt = value;
        return "ignored finalizer result";
      },
    ),
    (reason) => reason === error,
  );
  assert.equal(calls, 1);
  assert.ok(receipt);
  assert.deepEqual(receipt.outcome, { status: "fulfilled", value: "done" });
  assert.equal(receipt.events, undefined);
  assert.equal(receipt.lastSeq, 0);
});

for (const failFinalizer of [false, true]) {
  test(`successful prompt without events rejects after ${failFinalizer ? "failing" : "successful"} finalization`, async () => {
    const capture = createCapture(async () => 1);
    const finalizerError = new Error("finalizer must not hide missing capture");
    let calls = 0;
    let receipt: PromptCaptureReceipt<string> | undefined;
    await assert.rejects(
      capture.run(
        async () => "done",
        async (value) => {
          calls += 1;
          receipt = value;
          if (failFinalizer) {
            throw finalizerError;
          }
          return "not a successful capture";
        },
      ),
      /Missing ACP event capture/,
    );
    assert.equal(calls, 1);
    assert.ok(receipt);
    assert.deepEqual(receipt.outcome, { status: "fulfilled", value: "done" });
    assert.equal(receipt.events, undefined);
    assert.equal(receipt.lastSeq, 0);
  });
}

test("a primitive prompt rejection precedes missing capture and finalizer failure", async () => {
  const capture = createCapture(async () => 1);
  let calls = 0;
  let receipt: PromptCaptureReceipt<never> | undefined;
  await assert.rejects(
    capture.run(
      async () => {
        throw false;
      },
      async (value) => {
        calls += 1;
        receipt = value;
        throw new Error("finalizer failure");
      },
    ),
    (reason: unknown) => reason === false,
  );
  assert.equal(calls, 1);
  assert.ok(receipt);
  assert.deepEqual(receipt.outcome, { status: "rejected", reason: false });
  assert.equal(receipt.events, undefined);
  assert.equal(receipt.lastSeq, 0);
});

const finalizerRejections: Array<{ name: string; create: () => unknown }> = [
  { name: "frozen Error", create: () => Object.freeze(new Error("finalization failed")) },
  { name: "undefined", create: () => undefined },
  { name: "false", create: () => false },
];

for (const rejected of finalizerRejections) {
  test(`otherwise complete capture preserves ${rejected.name} finalizer rejection`, async () => {
    const capture = createCapture(async () => 4);
    const reason = rejected.create();
    let calls = 0;
    let receipt: PromptCaptureReceipt<string> | undefined;
    emit(capture);
    await assert.rejects(
      capture.run(
        async () => "done",
        async (value) => {
          calls += 1;
          receipt = value;
          throw reason;
        },
      ),
      (actual: unknown) => actual === reason,
    );
    assert.equal(calls, 1);
    assert.deepEqual(receipt, {
      outcome: { status: "fulfilled", value: "done" },
      events: { eventStartSeq: 4, eventEndSeq: 4 },
      lastSeq: 4,
    });
  });
}
