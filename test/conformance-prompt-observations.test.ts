import assert from "node:assert/strict";
import test from "node:test";
import type {
  ClientSideConnection,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { PromptObservations } from "../conformance/runner/prompt-observations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const response: PromptResponse = { stopReason: "end_turn" };
const params = (sessionId = "session"): PromptRequest => ({
  sessionId,
  prompt: [{ type: "text", text: "identical" }],
});
const notification = (sessionId = "session"): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "update" } },
});

function harness(holdFirst?: Promise<void>) {
  const updates: SessionNotification[] = [];
  const observations = new PromptObservations(updates);
  const completions: Array<ReturnType<typeof deferred<PromptResponse>>> = [];
  const entries: Array<ReturnType<typeof deferred<void>>> = [];
  const writes: Promise<void>[] = [];
  let received = 0;
  let closed = false;
  let aborted: unknown;
  const stream = observations.observeStream({
    readable: new ReadableStream({ start: (controller) => controller.close() }),
    writable: new WritableStream({
      write() {
        entries[received++].resolve();
        return received === 1 ? holdFirst : undefined;
      },
      close() {
        closed = true;
      },
      abort(reason: unknown) {
        aborted = reason;
      },
    }),
  });
  const writer = stream.writable.getWriter();
  const connection: Pick<ClientSideConnection, "prompt"> = {
    prompt(request) {
      const completion = deferred<PromptResponse>();
      completions.push(completion);
      entries.push(deferred<void>());
      writes.push(
        writer.write({
          jsonrpc: "2.0",
          id: completions.length,
          method: "session/prompt",
          params: request,
        }),
      );
      return completion.promise;
    },
  };
  return {
    updates,
    observations,
    completions,
    entries,
    writes,
    writer,
    connection,
    state: () => ({ received, closed, aborted }),
    dispatch: (request = params()) => observations.dispatch(connection, request),
  };
}

test("queued prompts exclude callbacks delivered before their message handoff", async () => {
  const held = deferred<void>();
  const h = harness(held.promise);
  try {
    const first = h.dispatch();
    await h.entries[0].promise;
    h.updates.push(notification());
    h.completions[0].resolve(response);
    await first.pending;
    const second = h.dispatch();
    h.updates.push(notification());
    assert.throws(() => h.observations.count(second.observation, "second"), /no observed handoff/);
    held.resolve();
    await h.entries[1].promise;
    h.completions[1].resolve(response);
    await second.pending;
    assert.equal(h.observations.count(first.observation, "first"), 1);
    assert.equal(h.observations.count(second.observation, "second"), 0);
  } finally {
    held.resolve();
    await Promise.all(h.writes);
    await h.writer.close();
  }
  assert.equal(h.state().closed, true);
});

test("identical payloads still represent distinct overlapping attempts", async () => {
  const h = harness();
  const first = h.dispatch(params());
  const second = h.dispatch(params());
  await Promise.all(h.writes);
  h.updates.push(notification());
  h.completions[0].resolve(response);
  h.completions[1].resolve(response);
  await Promise.all([first.pending, second.pending]);
  for (const observation of [first.observation, second.observation]) {
    assert.throws(() => h.observations.count(observation, "turn"), /ambiguous/);
  }
  await h.writer.close();
});

test("different-session overlap is filtered and a rejection freezes its scope", async () => {
  const h = harness();
  const first = h.dispatch(params("first"));
  const second = h.dispatch(params("second"));
  await Promise.all(h.writes);
  h.updates.push(notification("first"), notification("unowned"), notification("second"));
  const failure = new Error("unchanged SDK rejection");
  h.completions[0].reject(failure);
  h.completions[1].resolve(response);
  await assert.rejects(first.pending, (error) => error === failure);
  await second.pending;
  h.updates.push(notification("first"));
  assert.equal(h.observations.count(first.observation, "first"), 1);
  assert.equal(h.observations.count(second.observation, "second"), 1);
  await h.writer.close();
});

test("missing and unsettled observations cannot masquerade as empty completed scopes", async () => {
  const h = harness();
  assert.throws(() => h.observations.count(undefined, "missing"), /Unknown prompt update source/);
  const pending = h.dispatch();
  await Promise.all(h.writes);
  assert.throws(() => h.observations.count(pending.observation, "pending"), /still unsettled/);
  h.completions[0].resolve(response);
  await pending.pending;
  assert.equal(h.observations.count(pending.observation, "pending"), 0);
  await h.writer.close();
});

test("rejection before any handoff remains unbound and preserves the error", async () => {
  const h = harness();
  const failure = new Error("connection already closed");
  const observed = h.observations.dispatch({ prompt: () => Promise.reject(failure) }, params());
  await assert.rejects(observed.pending, (error) => error === failure);
  assert.equal(h.state().received, 0);
  assert.throws(() => h.observations.count(observed.observation, "closed"), /no observed handoff/);
  const reason = new Error("abort transport");
  await h.writer.abort(reason);
  assert.equal(h.state().aborted, reason);
});

for (const variant of ["unknown", "duplicate", "after-settlement"] as const) {
  test(`unbound or inconsistent outgoing prompts invalidate scoped proof: ${variant}`, async () => {
    const h = harness();
    const request = params();
    const observed = h.dispatch(request);
    await Promise.all(h.writes);
    if (variant === "after-settlement") {
      h.completions[0].resolve(response);
      await observed.pending;
    }
    h.entries.push(deferred<void>());
    await h.writer.write({
      jsonrpc: "2.0",
      id: 99,
      method: "session/prompt",
      params: variant === "unknown" ? { ...request } : request,
    });
    if (variant !== "after-settlement") {
      h.completions[0].resolve(response);
      await observed.pending;
    }
    assert.equal(h.state().received, 2, "observation faults must not swallow protocol messages");
    assert.throws(
      () => h.observations.count(observed.observation, "turn"),
      /Cannot correlate outgoing/,
    );
    await h.writer.close();
  });
}
