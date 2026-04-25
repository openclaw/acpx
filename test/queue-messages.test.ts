import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueOwnerMessage, parseQueueRequest } from "../src/cli/queue/messages.js";

test("parseQueueRequest accepts submit_prompt with nonInteractivePermissions", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-1",
    ownerGeneration: 123,
    message: "hello",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    timeoutMs: 1_500,
    waitForCompletion: true,
  });

  assert.deepEqual(parsed, {
    type: "submit_prompt",
    requestId: "req-1",
    ownerGeneration: 123,
    message: "hello",
    prompt: [{ type: "text", text: "hello" }],
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

test("parseQueueRequest accepts prompt session options", () => {
  const parsed = parseQueueRequest({
    type: "submit_prompt",
    requestId: "req-session-options",
    message: "hello",
    permissionMode: "approve-reads",
    sessionOptions: {
      model: "fast-model",
      allowedTools: ["Read", "Grep"],
      maxTurns: 4,
      systemPrompt: { append: "keep it brief" },
    },
    waitForCompletion: true,
  });

  assert.deepEqual(parsed, {
    type: "submit_prompt",
    requestId: "req-session-options",
    ownerGeneration: undefined,
    message: "hello",
    prompt: [{ type: "text", text: "hello" }],
    permissionMode: "approve-reads",
    nonInteractivePermissions: undefined,
    timeoutMs: undefined,
    waitForCompletion: true,
    sessionOptions: {
      model: "fast-model",
      allowedTools: ["Read", "Grep"],
      maxTurns: 4,
      systemPrompt: { append: "keep it brief" },
    },
  });
});

test("parseQueueRequest rejects invalid prompt session options", () => {
  assert.equal(
    parseQueueRequest({
      type: "submit_prompt",
      requestId: "req-session-options-invalid-model",
      message: "hello",
      permissionMode: "approve-reads",
      sessionOptions: {
        model: "   ",
      },
      waitForCompletion: true,
    }),
    null,
  );
  assert.equal(
    parseQueueRequest({
      type: "submit_prompt",
      requestId: "req-session-options-invalid-tools",
      message: "hello",
      permissionMode: "approve-reads",
      sessionOptions: {
        allowedTools: ["Read", 123],
      },
      waitForCompletion: true,
    }),
    null,
  );
});

test("parseQueueOwnerMessage accepts typed queue error payload", () => {
  const parsed = parseQueueOwnerMessage({
    type: "error",
    requestId: "req-err-1",
    ownerGeneration: 123,
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
    ownerGeneration: 123,
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

test("parseQueueRequest rejects invalid owner generation", () => {
  const parsed = parseQueueRequest({
    type: "cancel_prompt",
    requestId: "req-bad-generation",
    ownerGeneration: 0,
  });

  assert.equal(parsed, null);
});

test("parseQueueRequest accepts control requests and explicit prompt blocks", () => {
  assert.deepEqual(
    parseQueueRequest({
      type: "cancel_prompt",
      requestId: "req-cancel",
      ownerGeneration: 5,
    }),
    {
      type: "cancel_prompt",
      requestId: "req-cancel",
      ownerGeneration: 5,
    },
  );

  assert.deepEqual(
    parseQueueRequest({
      type: "set_mode",
      requestId: "req-mode",
      modeId: "plan",
      timeoutMs: 2_000,
    }),
    {
      type: "set_mode",
      requestId: "req-mode",
      ownerGeneration: undefined,
      modeId: "plan",
      timeoutMs: 2_000,
    },
  );

  assert.deepEqual(
    parseQueueRequest({
      type: "set_config_option",
      requestId: "req-config",
      configId: "thinking_level",
      value: "high",
    }),
    {
      type: "set_config_option",
      requestId: "req-config",
      ownerGeneration: undefined,
      configId: "thinking_level",
      value: "high",
      timeoutMs: undefined,
    },
  );

  assert.deepEqual(
    parseQueueRequest({
      type: "submit_prompt",
      requestId: "req-prompt",
      message: "ignored text fallback",
      prompt: [{ type: "text", text: "structured" }],
      permissionMode: "approve-all",
      suppressSdkConsoleErrors: false,
      waitForCompletion: false,
    }),
    {
      type: "submit_prompt",
      requestId: "req-prompt",
      ownerGeneration: undefined,
      message: "ignored text fallback",
      prompt: [{ type: "text", text: "structured" }],
      permissionMode: "approve-all",
      nonInteractivePermissions: undefined,
      timeoutMs: undefined,
      suppressSdkConsoleErrors: false,
      waitForCompletion: false,
    },
  );
});

test("parseQueueRequest rejects invalid control and prompt payload shapes", () => {
  assert.equal(parseQueueRequest(null), null);
  assert.equal(
    parseQueueRequest({
      type: "set_mode",
      requestId: "req-mode",
      modeId: "   ",
    }),
    null,
  );
  assert.equal(
    parseQueueRequest({
      type: "set_config_option",
      requestId: "req-config",
      configId: "thinking_level",
      value: "   ",
    }),
    null,
  );
  assert.equal(
    parseQueueRequest({
      type: "submit_prompt",
      requestId: "req-prompt",
      message: "hello",
      permissionMode: "approve-reads",
      prompt: [{ type: "image", mimeType: "text/plain", data: "bad" }],
      waitForCompletion: true,
    }),
    null,
  );
  assert.equal(
    parseQueueRequest({
      type: "submit_prompt",
      requestId: "req-prompt",
      message: "hello",
      permissionMode: "approve-reads",
      suppressSdkConsoleErrors: "nope",
      waitForCompletion: true,
    }),
    null,
  );
});

test("parseQueueOwnerMessage accepts structured non-error owner messages", () => {
  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "accepted",
      requestId: "req-accepted",
      ownerGeneration: 9,
    }),
    {
      type: "accepted",
      requestId: "req-accepted",
      ownerGeneration: 9,
    },
  );

  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "event",
      requestId: "req-event",
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
        },
      },
    }),
    {
      type: "event",
      requestId: "req-event",
      ownerGeneration: undefined,
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
        },
      },
    },
  );

  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "cancel_result",
      requestId: "req-cancel",
      cancelled: true,
    }),
    {
      type: "cancel_result",
      requestId: "req-cancel",
      ownerGeneration: undefined,
      cancelled: true,
    },
  );

  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "set_mode_result",
      requestId: "req-mode",
      modeId: "plan",
    }),
    {
      type: "set_mode_result",
      requestId: "req-mode",
      ownerGeneration: undefined,
      modeId: "plan",
    },
  );

  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "set_config_option_result",
      requestId: "req-config",
      response: {
        configOptions: [
          {
            id: "thinking_level",
            value: "high",
          },
        ],
      },
    }),
    {
      type: "set_config_option_result",
      requestId: "req-config",
      ownerGeneration: undefined,
      response: {
        configOptions: [
          {
            id: "thinking_level",
            value: "high",
          },
        ],
      },
    },
  );
});

test("parseQueueOwnerMessage accepts result payloads and optional emitted-error flag", () => {
  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "result",
      requestId: "req-result",
      result: {
        stopReason: "end_turn",
        sessionId: "session-1",
        resumed: true,
        permissionStats: {
          requested: 1,
          approved: 1,
          denied: 0,
          cancelled: 0,
        },
        record: {
          acpxRecordId: "record-1",
          acpSessionId: "session-1",
          agentCommand: "codex",
          cwd: "/tmp/work",
          createdAt: "2026-03-26T00:00:00.000Z",
          lastUsedAt: "2026-03-26T00:00:00.000Z",
          messages: [],
          updated_at: "2026-03-26T00:00:00.000Z",
          lastSeq: 0,
          eventLog: {
            stream_count: 0,
            segment_count: 0,
          },
        },
      },
    }),
    {
      type: "result",
      requestId: "req-result",
      ownerGeneration: undefined,
      result: {
        stopReason: "end_turn",
        sessionId: "session-1",
        resumed: true,
        permissionStats: {
          requested: 1,
          approved: 1,
          denied: 0,
          cancelled: 0,
        },
        record: {
          acpxRecordId: "record-1",
          acpSessionId: "session-1",
          agentCommand: "codex",
          cwd: "/tmp/work",
          createdAt: "2026-03-26T00:00:00.000Z",
          lastUsedAt: "2026-03-26T00:00:00.000Z",
          messages: [],
          updated_at: "2026-03-26T00:00:00.000Z",
          lastSeq: 0,
          eventLog: {
            stream_count: 0,
            segment_count: 0,
          },
        },
      },
    },
  );

  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "error",
      requestId: "req-err-emitted",
      code: "RUNTIME",
      origin: "queue",
      message: "already emitted",
      outputAlreadyEmitted: true,
    }),
    {
      type: "error",
      requestId: "req-err-emitted",
      ownerGeneration: undefined,
      code: "RUNTIME",
      detailCode: undefined,
      origin: "queue",
      message: "already emitted",
      retryable: undefined,
      acp: undefined,
      outputAlreadyEmitted: true,
    },
  );
});

test("parseQueueOwnerMessage rejects invalid structured owner message payloads", () => {
  assert.equal(
    parseQueueOwnerMessage({
      type: "accepted",
      requestId: "req-bad-owner-generation",
      ownerGeneration: 0,
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "event",
      requestId: "req-event",
      message: {
        method: "session/update",
      },
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "result",
      requestId: "req-result",
      result: {
        stopReason: "end_turn",
      },
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "cancel_result",
      requestId: "req-cancel",
      cancelled: "yes",
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "set_mode_result",
      requestId: "req-mode",
      modeId: 123,
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "set_config_option_result",
      requestId: "req-config",
      response: {},
    }),
    null,
  );
});
