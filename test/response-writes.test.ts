import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { ResponseWrites } from "../src/acp/response-writes.js";

test("response receipts match exact ids and only successful response writes", async () => {
  const writes = new ResponseWrites();
  const controller = new AbortController();
  let settled = false;
  const receipt = writes.track(1, controller.signal).then(() => {
    settled = true;
  });
  writes.written({ jsonrpc: "2.0", id: "1", result: {} });
  writes.written({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} });
  await Promise.resolve();
  assert.equal(settled, false);
  writes.written({ jsonrpc: "2.0", id: 1, result: {} });
  await receipt;
  assert.equal(settled, true);
  controller.abort();
  await receipt;
});

test("a retired connection cannot acknowledge an id reused on a new transport", async () => {
  const old = new ResponseWrites();
  const replacement = new ResponseWrites();
  const signal = new AbortController().signal;
  const stale = old.track(null, signal);
  const rejected = assert.rejects(stale, /connection closed/);
  old.close(new Error("connection closed"));
  await rejected;
  let settled = false;
  const current = replacement.track(null, signal).then(() => {
    settled = true;
  });
  old.written({ jsonrpc: "2.0", id: null, result: {} });
  await Promise.resolve();
  assert.equal(settled, false);
  replacement.written({ jsonrpc: "2.0", id: null, result: {} });
  await current;
});

test("pre-aborted requests reject their receipt without leaking an abort listener", async () => {
  const writes = new ResponseWrites();
  const reason = new Error("request cancelled");
  const signal = AbortSignal.abort(reason);
  await assert.rejects(writes.track("cancelled", signal), (error) => error === reason);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
