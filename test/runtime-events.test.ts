import assert from "node:assert/strict";
import test from "node:test";
import { parsePromptEventLine } from "../src/runtime/public/events.js";

test("parsePromptEventLine handles text chunks, usage updates, tool updates, and compatibility lines", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      }),
    ),
    {
      type: "text_delta",
      text: "hello",
      stream: "output",
      tag: "agent_message_chunk",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            text: "thinking",
          },
        },
      }),
    ),
    {
      type: "text_delta",
      text: "thinking",
      stream: "thought",
      tag: "agent_thought_chunk",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "usage_update",
            used: 12,
            size: 500,
          },
        },
      }),
    ),
    {
      type: "status",
      text: "usage updated: 12/500",
      tag: "usage_update",
      used: 12,
      size: 500,
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_ABC123",
            status: "in_progress",
          },
        },
      }),
    ),
    {
      type: "tool_call",
      text: "tool call (in_progress)",
      tag: "tool_call_update",
      toolCallId: "call_ABC123",
      status: "in_progress",
      title: "tool call",
    },
  );

  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "text", content: "alpha" })), {
    type: "text_delta",
    text: "alpha",
    stream: "output",
  });
  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "done", stopReason: "end_turn" })), {
    type: "done",
    stopReason: "end_turn",
  });
});

test("parsePromptEventLine handles runtime status-style updates", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "available_commands_update",
        availableCommands: ["a", "b"],
      }),
    ),
    {
      type: "status",
      text: "available commands updated (2)",
      tag: "available_commands_update",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "current_mode_update",
        currentModeId: "architect",
      }),
    ),
    {
      type: "status",
      text: "mode updated: architect",
      tag: "current_mode_update",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "config_option_update",
        id: "approval",
        currentValue: "manual",
      }),
    ),
    {
      type: "status",
      text: "config updated: approval=manual",
      tag: "config_option_update",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "session_info_update",
        summary: "ready",
      }),
    ),
    {
      type: "status",
      text: "ready",
      tag: "session_info_update",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "plan",
        entries: [{ content: "first step" }],
      }),
    ),
    {
      type: "status",
      text: "plan: first step",
      tag: "plan",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        type: "client_operation",
        method: "write_file",
        status: "ok",
        summary: "saved notes.md",
      }),
    ),
    {
      type: "status",
      text: "write_file ok saved notes.md",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ type: "update", update: "loading session" })),
    {
      type: "status",
      text: "loading session",
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({ type: "error", message: "broken", code: "E1", retryable: true }),
    ),
    {
      type: "error",
      message: "broken",
      code: "E1",
      retryable: true,
    },
  );
});

test("parsePromptEventLine ignores unsupported structured payloads and treats raw lines as status", () => {
  assert.equal(parsePromptEventLine("   "), null);
  assert.deepEqual(parsePromptEventLine("plain runtime note"), {
    type: "status",
    text: "plain runtime note",
  });
  assert.equal(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "image", text: "ignored" },
          },
        },
      }),
    ),
    null,
  );
  assert.equal(parsePromptEventLine(JSON.stringify({ type: "update", update: "   " })), null);
  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "client_operation" })), {
    type: "status",
    text: "operation",
  });
  assert.equal(parsePromptEventLine(JSON.stringify({ type: "plan", entries: [] })), null);
});
