import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueOwnerMessage, parseQueueRequest } from "../src/queue-messages.js";

test("parseQueueRequest accepts submit_prompt with nonInteractivePermissions", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-1",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    timeoutMs: 1_500,
    waitForCompletion: true,
  });

  assert.deepEqual(parsed, {
    type: "submit_prompt",
    requestId: "req-1",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    timeoutMs: 1_500,
    waitForCompletion: true,
  });
});

test("parseQueueRequest rejects invalid nonInteractivePermissions value", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-2",
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "invalid",
    waitForCompletion: false,
  });

  assert.equal(parsed, null);
});

test("parseQueueOwnerMessage accepts typed queue error payload", () => {
  const parsed = parseQueueOwnerMessage({
    type: "error",
    requestId: "req-err-1",
    code: "RUNTIME",
    detailCode: "QUEUE_OWNER_CLOSED",
    origin: "queue",
    retryable: true,
    message: "Queue owner is closed",
    acp: {
      code: -32002,
      message: "Resource not found",
      data: {
        sessionId: "abc",
      },
    },
  });

  assert.deepEqual(parsed, {
    type: "error",
    requestId: "req-err-1",
    code: "RUNTIME",
    detailCode: "QUEUE_OWNER_CLOSED",
    origin: "queue",
    retryable: true,
    message: "Queue owner is closed",
    acp: {
      code: -32002,
      message: "Resource not found",
      data: {
        sessionId: "abc",
      },
    },
  });
});

test("parseQueueOwnerMessage rejects untyped queue error payload", () => {
  const parsed = parseQueueOwnerMessage({
    type: "error",
    requestId: "req-err-untyped",
    message: "message only",
  });

  assert.equal(parsed, null);
});
