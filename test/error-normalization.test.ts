import assert from "node:assert/strict";
import test from "node:test";
import {
  exitCodeForOutputErrorCode,
  normalizeOutputError,
  isAcpResourceNotFoundError,
} from "../src/error-normalization.js";
import {
  PermissionPromptUnavailableError,
  QueueConnectionError,
  AuthPolicyError,
} from "../src/errors.js";

test("normalizeOutputError maps permission prompt unavailable errors", () => {
  const normalized = normalizeOutputError(new PermissionPromptUnavailableError(), {
    origin: "runtime",
  });

  assert.equal(normalized.code, "PERMISSION_PROMPT_UNAVAILABLE");
  assert.equal(normalized.origin, "runtime");
  assert.match(normalized.message, /Permission prompt unavailable/i);
});

test("normalizeOutputError maps ACP resource not found errors to NO_SESSION", () => {
  const error = {
    code: -32002,
    message: "Resource not found: session",
    data: {
      sessionId: "abc",
    },
  };

  const normalized = normalizeOutputError(error, {
    origin: "acp",
  });

  assert.equal(normalized.code, "NO_SESSION");
  assert.equal(normalized.origin, "acp");
  assert.deepEqual(normalized.acp, {
    code: -32002,
    message: "Resource not found: session",
    data: {
      sessionId: "abc",
    },
  });
  assert.equal(isAcpResourceNotFoundError(error), true);
});

test("normalizeOutputError maps legacy ACP -32001 resource errors to NO_SESSION", () => {
  const error = {
    code: -32001,
    message: "Resource not found",
  };

  const normalized = normalizeOutputError(error, {
    origin: "acp",
  });

  assert.equal(normalized.code, "NO_SESSION");
  assert.equal(normalized.origin, "acp");
  assert.equal(normalized.acp?.code, -32001);
});

test("normalizeOutputError maps ACP -32603 with session-not-found details to NO_SESSION", () => {
  const error = {
    error: {
      code: -32603,
      message: "Internal error",
      data: {
        details: "Session not found",
      },
    },
  };

  const normalized = normalizeOutputError(error, {
    origin: "acp",
  });

  assert.equal(normalized.code, "NO_SESSION");
  assert.equal(normalized.origin, "acp");
  assert.equal(isAcpResourceNotFoundError(error), true);
});

test("normalizeOutputError falls back to message-based resource detection", () => {
  const normalized = normalizeOutputError(
    new Error("session not found while reconnecting"),
    {
      origin: "runtime",
    },
  );

  assert.equal(normalized.code, "NO_SESSION");
  assert.equal(normalized.origin, "runtime");
});

test("normalizeOutputError preserves queue metadata from typed queue errors", () => {
  const error = new QueueConnectionError("Queue denied control request", {
    outputCode: "PERMISSION_DENIED",
    detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
    origin: "queue",
    retryable: false,
  });

  const normalized = normalizeOutputError(error);
  assert.equal(normalized.code, "PERMISSION_DENIED");
  assert.equal(normalized.detailCode, "QUEUE_CONTROL_REQUEST_FAILED");
  assert.equal(normalized.origin, "queue");
  assert.equal(normalized.retryable, false);
});

test("normalizeOutputError maps AuthPolicyError to AUTH_REQUIRED detail", () => {
  const normalized = normalizeOutputError(
    new AuthPolicyError("missing credentials for auth method token"),
  );

  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.detailCode, "AUTH_REQUIRED");
  assert.equal(normalized.origin, "acp");
});

test("normalizeOutputError infers AUTH_REQUIRED detail from ACP payload", () => {
  const normalized = normalizeOutputError({
    error: {
      code: -32000,
      message: "Authentication required",
      data: {
        methodId: "token",
      },
    },
  });

  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.detailCode, "AUTH_REQUIRED");
  assert.equal(normalized.acp?.code, -32000);
});

test("exitCodeForOutputErrorCode maps machine codes to stable exits", () => {
  assert.equal(exitCodeForOutputErrorCode("USAGE"), 2);
  assert.equal(exitCodeForOutputErrorCode("TIMEOUT"), 3);
  assert.equal(exitCodeForOutputErrorCode("NO_SESSION"), 4);
  assert.equal(exitCodeForOutputErrorCode("PERMISSION_DENIED"), 5);
  assert.equal(exitCodeForOutputErrorCode("PERMISSION_PROMPT_UNAVAILABLE"), 5);
  assert.equal(exitCodeForOutputErrorCode("RUNTIME"), 1);
});
