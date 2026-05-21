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
        sessionUpdate: "tool_call_update",
        title: "Read",
        toolCallId: "call_READ_WITH_INPUT",
        rawInput: { path: "src/app.ts" },
        rawOutput: { stdout: "fresh output" },
      }),
    ),
    {
      type: "tool_call",
      text: "Read: fresh output",
      tag: "tool_call_update",
      toolCallId: "call_READ_WITH_INPUT",
      title: "Read",
      rawInput: { path: "src/app.ts" },
      rawOutput: { stdout: "fresh output" },
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
            toolCallId: "call_READ",
            status: "in_progress",
            rawOutput: {
              content: [{ type: "text", text: "partial output" }],
              details: { path: "src/app.ts" },
            },
            content: [
              {
                type: "content",
                content: { type: "text", text: "partial output" },
              },
            ],
            locations: [{ path: "src/app.ts", line: 12 }],
          },
        },
      }),
    ),
    {
      type: "tool_call",
      text: "tool call (in_progress): partial output",
      tag: "tool_call_update",
      toolCallId: "call_READ",
      status: "in_progress",
      title: "tool call",
      rawOutput: {
        content: [{ type: "text", text: "partial output" }],
        details: { path: "src/app.ts" },
      },
      content: [
        {
          type: "content",
          content: { type: "text", text: "partial output" },
        },
      ],
      locations: [{ path: "src/app.ts", line: 12 }],
    },
  );

  const longOutput = "x".repeat(600);
  const parsedLongUpdate = parsePromptEventLine(
    JSON.stringify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_LONG",
      rawOutput: { stdout: longOutput },
    }),
  );
  assert.equal(parsedLongUpdate?.type, "tool_call");
  assert.equal(parsedLongUpdate?.text.length, 511);
  assert.match(parsedLongUpdate?.text ?? "", /^tool call: x+…$/);

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

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_SEARCH",
            title: "Search",
            status: "in_progress",
            rawInput: {
              command: "rg",
              args: ["-n", "needle"],
            },
          },
        },
      }),
    ),
    {
      type: "tool_call",
      text: "Search (in_progress): rg -n needle",
      tag: "tool_call",
      toolCallId: "call_SEARCH",
      status: "in_progress",
      rawInput: {
        command: "rg",
        args: ["-n", "needle"],
      },
      title: "Search",
    },
  );

  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "text", content: "alpha" })), {
    type: "text_delta",
    text: "alpha",
    stream: "output",
  });
  assert.equal(
    parsePromptEventLine(JSON.stringify({ type: "done", stopReason: "end_turn" })),
    null,
  );
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

  assert.equal(
    parsePromptEventLine(
      JSON.stringify({ type: "error", message: "broken", code: "E1", retryable: true }),
    ),
    null,
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
  assert.deepEqual(parsePromptEventLine(JSON.stringify(["not", "an", "object"])), {
    type: "status",
    text: '["not","an","object"]',
  });
  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "usage_update", used: "bad" })), {
    type: "status",
    text: "usage updated",
    tag: "usage_update",
  });
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        type: "tool_call",
        title: "run",
        status: "started",
        kind: "execute",
        toolCallId: "tool-1",
        rawInput: { command: "node", args: ["--version"] },
        locations: [{ path: "package.json" }],
      }),
    ),
    {
      type: "tool_call",
      text: "run (started): node --version",
      tag: "tool_call",
      title: "run",
      toolCallId: "tool-1",
      status: "started",
      kind: "execute",
      rawInput: { command: "node", args: ["--version"] },
      locations: [{ path: "package.json" }],
    },
  );
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        type: "tool_call_update",
        title: "read",
        content: [
          { type: "resource_link", title: "README.md", uri: "file:///README.md" },
          { type: "resource", resource: { text: "body" } },
          { type: "diff", path: "src/index.ts" },
          { type: "terminal", terminalId: "term-1" },
        ],
      }),
    ),
    {
      type: "tool_call",
      text: "read: README.md\nbody\ndiff src/index.ts\n[terminal] term-1",
      tag: "tool_call_update",
      title: "read",
      content: [
        { type: "resource_link", title: "README.md", uri: "file:///README.md" },
        { type: "resource", resource: { text: "body" } },
        { type: "diff", path: "src/index.ts" },
        { type: "terminal", terminalId: "term-1" },
      ],
    },
  );
  assert.equal(parsePromptEventLine(JSON.stringify({ type: "__proto__", content: "x" })), null);
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        type: "tool_call_update",
        content: [{ type: "__proto__", text: "x" }],
      }),
    ),
    {
      type: "tool_call",
      text: "tool call",
      tag: "tool_call_update",
      title: "tool call",
      content: [{ type: "__proto__", text: "x" }],
    },
  );
});

test("parsePromptEventLine covers status and tool summary fallbacks", () => {
  assert.equal(
    parsePromptEventLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} })),
    null,
  );
  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ sessionUpdate: "available_commands_update" })),
    {
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    },
  );
  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ sessionUpdate: "current_mode_update", modeId: "fast" })),
    {
      type: "status",
      text: "mode updated: fast",
      tag: "current_mode_update",
    },
  );
  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ sessionUpdate: "config_option_update", id: "mode" })),
    {
      type: "status",
      text: "config updated: mode",
      tag: "config_option_update",
    },
  );
  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ sessionUpdate: "config_option_update" })),
    {
      type: "status",
      text: "config updated",
      tag: "config_option_update",
    },
  );
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({ sessionUpdate: "session_info_update", message: "ready" }),
    ),
    {
      type: "status",
      text: "ready",
      tag: "session_info_update",
    },
  );
  assert.equal(
    parsePromptEventLine(JSON.stringify({ sessionUpdate: "plan", entries: ["skip"] })),
    null,
  );
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        content: { text: "hello" },
      }),
    ),
    {
      type: "text_delta",
      text: "hello",
      stream: "output",
      tag: "agent_message_chunk",
    },
  );
  assert.equal(
    parsePromptEventLine(
      JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }),
    ),
    null,
  );
  assert.deepEqual(parsePromptEventLine(JSON.stringify({ type: "tool_call", rawInput: 42 })), {
    type: "tool_call",
    text: "tool call: 42",
    tag: "tool_call",
    title: "tool call",
    rawInput: 42,
  });
  assert.deepEqual(
    parsePromptEventLine(JSON.stringify({ type: "tool_call_update", rawOutput: true })),
    {
      type: "tool_call",
      text: "tool call: true",
      tag: "tool_call_update",
      title: "tool call",
      rawOutput: true,
    },
  );
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({ type: "tool_call_update", rawOutput: { stderr: "bad" } }),
    ),
    {
      type: "tool_call",
      text: "tool call: bad",
      tag: "tool_call_update",
      title: "tool call",
      rawOutput: { stderr: "bad" },
    },
  );
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        type: "tool_call_update",
        content: [
          { type: "resource_link", uri: "file:///fallback" },
          { type: "resource", resource: { uri: "file:///resource" } },
          { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
          { type: "terminal" },
        ],
      }),
    ),
    {
      type: "tool_call",
      text: "tool call: file:///fallback\nfile:///resource\n[audio] audio/wav\n[terminal]",
      tag: "tool_call_update",
      title: "tool call",
      content: [
        { type: "resource_link", uri: "file:///fallback" },
        { type: "resource", resource: { uri: "file:///resource" } },
        { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
        { type: "terminal" },
      ],
    },
  );
});
