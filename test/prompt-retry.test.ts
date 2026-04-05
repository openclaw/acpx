import assert from "node:assert/strict";
import test from "node:test";
import { isRetryablePromptError } from "../src/acp/error-normalization.js";
import { PermissionDeniedError, PermissionPromptUnavailableError } from "../src/errors.js";

// --- isRetryablePromptError ---

test("isRetryablePromptError returns true for ACP internal error (-32603)", () => {
  const error = { code: -32603, message: "Internal error" };
  assert.equal(isRetryablePromptError(error), true);
});

test("isRetryablePromptError returns true for ACP parse error (-32700)", () => {
  const error = { code: -32700, message: "Parse error" };
  assert.equal(isRetryablePromptError(error), true);
});

test("isRetryablePromptError returns true for wrapped ACP internal error", () => {
  const error = new Error("prompt failed");
  (error as Error & { error?: unknown }).error = {
    code: -32603,
    message: "Internal error",
    data: { details: "model returned HTTP 400" },
  };
  assert.equal(isRetryablePromptError(error), true);
});

test("isRetryablePromptError returns false for auth-required error (-32000)", () => {
  const error = { code: -32000, message: "Authentication required" };
  assert.equal(isRetryablePromptError(error), false);
});

test("isRetryablePromptError returns false for method-not-found error (-32601)", () => {
  const error = { code: -32601, message: "Method not found: session/prompt" };
  assert.equal(isRetryablePromptError(error), false);
});

test("isRetryablePromptError returns false for invalid-params error (-32602)", () => {
  const error = { code: -32602, message: "Invalid params" };
  assert.equal(isRetryablePromptError(error), false);
});

test("isRetryablePromptError returns false for resource-not-found error (-32002)", () => {
  const error = { code: -32002, message: "Resource not found: session" };
  assert.equal(isRetryablePromptError(error), false);
});

test("isRetryablePromptError returns false for PermissionDeniedError", () => {
  assert.equal(isRetryablePromptError(new PermissionDeniedError("denied")), false);
});

test("isRetryablePromptError returns false for PermissionPromptUnavailableError", () => {
  assert.equal(isRetryablePromptError(new PermissionPromptUnavailableError()), false);
});

test("isRetryablePromptError returns false for TimeoutError", () => {
  const error = new Error("timeout");
  error.name = "TimeoutError";
  assert.equal(isRetryablePromptError(error), false);
});

test("isRetryablePromptError returns false for non-ACP errors", () => {
  assert.equal(isRetryablePromptError(new Error("random failure")), false);
});

test("isRetryablePromptError returns false for null/undefined", () => {
  assert.equal(isRetryablePromptError(null), false);
  assert.equal(isRetryablePromptError(undefined), false);
});

test("isRetryablePromptError returns false for auth message in -32603 error", () => {
  const error = { code: -32000, message: "auth required" };
  assert.equal(isRetryablePromptError(error), false);
});
