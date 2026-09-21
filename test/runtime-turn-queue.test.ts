import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { AsyncEventQueue } from "../src/runtime/engine/turn.js";
import type { AcpRuntimeEvent } from "../src/runtime/public/contract.js";

const first: AcpRuntimeEvent = { type: "text_delta", text: "first" };
const second: AcpRuntimeEvent = { type: "text_delta", text: "second" };

for (const exit of ["break", "throw", "return"] as const) {
  test(`turn event queue releases buffered and future events after consumer ${exit}`, async () => {
    const queue = new AsyncEventQueue();
    queue.push(first);
    queue.push(second);
    if (exit === "return") {
      const iterator = queue.iterate()[Symbol.asyncIterator]();
      assert.deepEqual(await iterator.next(), { done: false, value: first });
      assert.ok(iterator.return);
      await iterator.return();
    } else {
      const failure = new Error("observer failed");
      const consume = async () => {
        for await (const event of queue.iterate()) {
          assert.deepEqual(event, first);
          if (exit === "throw") {
            throw failure;
          }
          break;
        }
      };
      if (exit === "throw") {
        await assert.rejects(consume, (error) => error === failure);
      } else {
        await consume();
      }
    }
    queue.push({ type: "text_delta", text: "unobserved" });
    assert.equal(await queue.next(), null);
  });
}

test("turn event queue drains buffered output when the producer closes normally", async () => {
  const queue = new AsyncEventQueue();
  const received: AcpRuntimeEvent[] = [];
  const reading = (async () => {
    for await (const event of queue.iterate()) {
      received.push(event);
    }
  })();
  queue.push(first);
  queue.push(second);
  queue.close();
  await reading;
  assert.deepEqual(received, [first, second]);
  assert.equal(await queue.next(), null);
});

test("abandoned turn event queues do not retain subsequent event objects", async () => {
  class BufferedEvent {
    readonly type = "text_delta";
    readonly text = "x".repeat(128);
  }
  const queue = new AsyncEventQueue();
  queue.push(first);
  for await (const event of queue.iterate()) {
    assert.deepEqual(event, first);
    break;
  }
  const emit = () => {
    for (let index = 0; index < 512; index += 1) {
      queue.push(new BufferedEvent());
    }
  };
  emit();
  await nextTurn();
  assert.equal(queryObjects(BufferedEvent, { format: "count" }), 0);
  assert.equal(await queue.next(), null);
});
