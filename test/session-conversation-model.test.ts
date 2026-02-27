import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  createSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session-conversation-model.js";

test("conversation model captures prompt, chunks, tool calls, and metadata", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  let acpxState = undefined;

  recordPromptSubmission(conversation, "hello", "2026-02-27T10:00:00.000Z");

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi " },
      },
    } as SessionNotification,
    "2026-02-27T10:00:01.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    } as SessionNotification,
    "2026-02-27T10:00:02.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Run ls",
        status: "in_progress",
        kind: "execute",
        rawInput: { command: "ls" },
      },
    } as SessionNotification,
    "2026-02-27T10:00:03.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } as SessionNotification,
    "2026-02-27T10:00:04.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "create_plan", description: "create plan" }],
      },
    } as SessionNotification,
    "2026-02-27T10:00:05.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "code",
      },
    } as SessionNotification,
    "2026-02-27T10:00:06.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "My Session",
        updatedAt: "2026-02-27T10:00:06.000Z",
      },
    } as SessionNotification,
    "2026-02-27T10:00:06.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
        _meta: {
          usage: {
            inputTokens: 60,
            outputTokens: 40,
            cachedWriteTokens: 10,
            cachedReadTokens: 15,
          },
        },
      },
    } as SessionNotification,
    "2026-02-27T10:00:07.000Z",
  );

  acpxState = recordClientOperation(
    conversation,
    acpxState,
    {
      method: "terminal/create",
      status: "completed",
      summary: "Ran ls",
      timestamp: "2026-02-27T10:00:08.000Z",
    },
    "2026-02-27T10:00:08.000Z",
  );

  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.title, "My Session");

  const user = conversation.messages[0];
  const agent = conversation.messages[1];

  assert.ok(typeof user === "object" && user !== null && "User" in user);
  assert.ok(typeof agent === "object" && agent !== null && "Agent" in agent);

  if (!(typeof user === "object" && user !== null && "User" in user)) {
    assert.fail("expected User message");
  }
  if (!(typeof agent === "object" && agent !== null && "Agent" in agent)) {
    assert.fail("expected Agent message");
  }

  const tool = agent.Agent.content.find(
    (entry) => "ToolUse" in entry && entry.ToolUse.id === "call_1",
  );
  assert.ok(tool);
  assert.equal(agent.Agent.tool_results.call_1?.tool_name, "Run ls");
  assert.deepEqual(agent.Agent.tool_results.call_1?.output, { exitCode: 0 });

  const userId = user.User.id;
  assert.deepEqual(conversation.request_token_usage[userId], {
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 15,
  });
  assert.deepEqual(conversation.cumulative_token_usage, {
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 15,
  });

  assert.equal(acpxState?.current_mode_id, "code");
  assert.deepEqual(acpxState?.available_commands, ["create_plan"]);
});

test("recordClientOperation keeps state and advances timestamp", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  const state = recordClientOperation(
    conversation,
    { current_mode_id: "code" },
    {
      method: "terminal/output",
      status: "running",
      summary: "tail -f",
      timestamp: "2026-02-27T10:00:05.000Z",
    },
    "2026-02-27T10:00:05.000Z",
  );

  assert.equal(state?.current_mode_id, "code");
  assert.equal(conversation.updated_at, "2026-02-27T10:00:05.000Z");
});
