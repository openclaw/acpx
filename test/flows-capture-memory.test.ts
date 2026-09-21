import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { FlowRunner } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import type { FlowSessionBinding } from "../src/flows/types.js";
import type { AcpJsonRpcMessage, AcpMessageDirection } from "../src/types.js";

type Capture = {
  onAcpMessage(direction: AcpMessageDirection, message: AcpJsonRpcMessage): void;
  run<T>(operation: () => Promise<T>): Promise<{
    result: T;
    eventStartSeq: number;
    eventEndSeq: number;
  }>;
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
  // A mock call ledger would itself retain every promise in the heap assertion.
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

test("long prompts release settled capture writes before the prompt finishes", async () => {
  class CaptureWrite<T> extends Promise<T> {}
  let seq = 0;
  const capture = createCapture(() => CaptureWrite.resolve(++seq));
  for (let index = 0; index < 512; index += 1) {
    emit(capture);
  }
  await nextTurn();
  const retained = queryObjects(CaptureWrite, { format: "count" });
  const result = await capture.run(async () => "done");
  assert.ok(retained < 8, `settled capture writes retained during prompt: ${retained}`);
  assert.deepEqual(result, { result: "done", eventStartSeq: 1, eventEndSeq: 512 });
});

test("capture drains delayed writes and preserves the full sequence range", async () => {
  const delayed = deferred<number>();
  let index = 0;
  const capture = createCapture(() => (++index === 1 ? delayed.promise : Promise.resolve(9)));
  emit(capture);
  emit(capture);
  let settled = false;
  const result = capture
    .run(async () => "done")
    .finally(() => {
      settled = true;
    });
  await nextTurn();
  assert.equal(settled, false);
  delayed.resolve(3);
  assert.deepEqual(await result, { result: "done", eventStartSeq: 3, eventEndSeq: 9 });
});

for (const failOperation of [false, true]) {
  test(`capture drains all failures and preserves ${failOperation ? "operation" : "event"} precedence`, async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const firstError = new Error("first event failed");
    const operationError = new Error("prompt failed");
    let index = 0;
    const capture = createCapture(() => (++index === 1 ? first.promise : second.promise));
    emit(capture);
    emit(capture);
    let settled = false;
    const result = capture
      .run(async () => {
        if (failOperation) {
          throw operationError;
        }
        return "done";
      })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    second.reject(new Error("second event failed sooner"));
    await nextTurn();
    assert.equal(settled, false);
    first.reject(firstError);
    assert.equal(await result, failOperation ? operationError : firstError);
  });
}

test("capture remembers failures after their writes have settled", async () => {
  const error = new Error("journal failed");
  const capture = createCapture(() => Promise.reject(error));
  emit(capture);
  await nextTurn();
  await assert.rejects(
    capture.run(async () => "done"),
    (reason) => reason === error,
  );
});

test("capture still rejects a successful prompt without events", async () => {
  const capture = createCapture(async () => 1);
  await assert.rejects(
    capture.run(async () => "done"),
    /Missing ACP event capture/,
  );
});
