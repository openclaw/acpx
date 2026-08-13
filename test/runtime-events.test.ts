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
        availableCommands: [
          { name: "/compact", description: "Compact context" },
          { name: "/clear" },
        ],
      }),
    ),
    {
      type: "status",
      text: "available commands updated (2)",
      tag: "available_commands_update",
      availableCommands: [
        { name: "/compact", description: "Compact context", hasInput: false },
        { name: "/clear", hasInput: false },
      ],
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
      availableCommands: [],
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

test("parsePromptEventLine surfaces cost and _meta.usage breakdown on usage_update", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200_000,
        cost: { amount: 0.0123, currency: "USD" },
        _meta: {
          usage: {
            inputTokens: 800,
            outputTokens: 400,
            cachedReadTokens: 600,
            cachedWriteTokens: 50,
            thoughtTokens: 75,
            totalTokens: 1925,
          },
        },
      }),
    ),
    {
      type: "status",
      text: "usage updated: 1200/200000",
      tag: "usage_update",
      used: 1200,
      size: 200_000,
      cost: { amount: 0.0123, currency: "USD" },
      breakdown: {
        inputTokens: 800,
        outputTokens: 400,
        cachedReadTokens: 600,
        cachedWriteTokens: 50,
        thoughtTokens: 75,
        totalTokens: 1925,
      },
    },
  );

  // Cost is forwarded even when only one field is populated.
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.05 },
      }),
    ),
    {
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
      cost: { amount: 0.05 },
    },
  );

  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "usage_update",
        used: 25,
        size: 100,
        _meta: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            thought_tokens: 1,
            total_tokens: 21,
          },
        },
      }),
    ),
    {
      type: "status",
      text: "usage updated: 25/100",
      tag: "usage_update",
      used: 25,
      size: 100,
      breakdown: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 3,
        cachedWriteTokens: 2,
        thoughtTokens: 1,
        totalTokens: 21,
      },
    },
  );

  // _meta without a usage record is ignored — no synthetic breakdown.
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "usage_update",
        used: 5,
        size: 100,
        _meta: { somethingElse: "ignored" },
      }),
    ),
    {
      type: "status",
      text: "usage updated: 5/100",
      tag: "usage_update",
      used: 5,
      size: 100,
    },
  );
});

test("parsePromptEventLine surfaces full availableCommands list with hasInput flag", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "/compact",
            description: "Compact the conversation",
            // No input → hasInput should be false.
          },
          {
            name: "/search",
            description: "Search the workspace",
            input: { hint: "query" },
          },
          {
            // Missing name → dropped.
            description: "no name",
          },
          // Bare string entry — non-spec but should not crash.
          "/clear",
          {
            name: "  ", // whitespace-only name → dropped.
            description: "blank",
          },
          {
            name: "/cost",
            // No description, no input.
          },
        ],
      }),
    ),
    {
      type: "status",
      text: "available commands updated (3)",
      tag: "available_commands_update",
      availableCommands: [
        { name: "/compact", description: "Compact the conversation", hasInput: false },
        { name: "/search", description: "Search the workspace", hasInput: true },
        { name: "/cost", hasInput: false },
      ],
    },
  );
});

test("parsePromptEventLine preserves messageId and allowlisted _meta on agent_message_chunk text_delta", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_assistant_1",
        _meta: {
          origin: "assistant",
          kind: "model",
          source: "codex-acp",
          // nested objects and unknown keys are dropped
          nested: { source: "codex-acp" },
          dropList: ["nope"],
        },
        content: { type: "text", text: "hello from model" },
      }),
    ),
    {
      type: "text_delta",
      text: "hello from model",
      stream: "output",
      tag: "agent_message_chunk",
      messageId: "msg_assistant_1",
      meta: {
        origin: "assistant",
        kind: "model",
        source: "codex-acp",
      },
    },
  );

  // Diagnostic-shaped chunk: same tag, different origin metadata
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_diag_1",
        _meta: { origin: "adapter", kind: "diagnostic" },
        content: { type: "text", text: "warning: tool timeout" },
      }),
    ),
    {
      type: "text_delta",
      text: "warning: tool timeout",
      stream: "output",
      tag: "agent_message_chunk",
      messageId: "msg_diag_1",
      meta: { origin: "adapter", kind: "diagnostic" },
    },
  );
});

test("parsePromptEventLine drops unknown and secret-like _meta keys from text_delta", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_sec_1",
        _meta: {
          origin: "assistant",
          kind: "model",
          apiKey: "redacted",
          authorization: "redacted",
          token: "redacted",
          internalUrl: "https://internal.example/diagnostics",
          nested: { apiKey: "redacted" },
        },
        content: { type: "text", text: "safe body" },
      }),
    ),
    {
      type: "text_delta",
      text: "safe body",
      stream: "output",
      tag: "agent_message_chunk",
      messageId: "msg_sec_1",
      meta: { origin: "assistant", kind: "model" },
    },
  );
});

test("parsePromptEventLine omits origin fields when messageId/_meta are absent or empty", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        messageId: "   ",
        _meta: {},
        content: { type: "text", text: "plain" },
      }),
    ),
    {
      type: "text_delta",
      text: "plain",
      stream: "output",
      tag: "agent_message_chunk",
    },
  );
});

test("parsePromptEventLine ignores non-ACP message_id and meta aliases", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        message_id: "msg_snake",
        meta: { origin: "assistant" },
        content: { type: "text", text: "aliased" },
      }),
    ),
    {
      type: "text_delta",
      text: "aliased",
      stream: "output",
      tag: "agent_message_chunk",
    },
  );
});

test("parsePromptEventLine preserves origin on agent_thought_chunk", () => {
  assert.deepEqual(
    parsePromptEventLine(
      JSON.stringify({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought_1",
        _meta: { origin: "assistant" },
        content: { type: "text", text: "reasoning" },
      }),
    ),
    {
      type: "text_delta",
      text: "reasoning",
      stream: "thought",
      tag: "agent_thought_chunk",
      messageId: "thought_1",
      meta: { origin: "assistant" },
    },
  );
});
