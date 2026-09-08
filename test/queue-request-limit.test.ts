import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQueueRequestSize,
  queueRequestByteLimit,
  queueRequestExceedsLimit,
} from "../src/cli/queue/request-limit.js";

test("queue limits validate opt-in settings and count UTF-8 bytes", () => {
  assert.equal(queueRequestByteLimit("0"), undefined);
  assert.equal(queueRequestByteLimit(""), undefined);
  assert.equal(queueRequestByteLimit("1024"), 1024);
  for (const raw of ["-1", "1.5", "Infinity", "9007199254740992"]) {
    assert.throws(() => queueRequestByteLimit(raw), /ACPX_QUEUE_MAX_REQUEST_BYTES/);
  }
  assert.equal(queueRequestExceedsLimit("é", 2), false);
  assert.equal(queueRequestExceedsLimit("é", 1), true);
  const previous = process.env.ACPX_QUEUE_MAX_REQUEST_BYTES;
  process.env.ACPX_QUEUE_MAX_REQUEST_BYTES = "1";
  try {
    assert.throws(() => assertQueueRequestSize("é"), {
      detailCode: "QUEUE_REQUEST_TOO_LARGE",
      retryable: false,
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_QUEUE_MAX_REQUEST_BYTES;
    } else {
      process.env.ACPX_QUEUE_MAX_REQUEST_BYTES = previous;
    }
  }
});
