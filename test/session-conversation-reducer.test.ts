import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  createSessionConversation,
  recordPromptResponseUsage,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import {
  cloneConversation,
  cloneSessionAcpxState,
  createConversation,
  reducePromptResponseUsage,
  reducePromptSubmission,
  reduceSessionUpdate,
} from "../src/session/conversation-reducer.js";
import { trimConversationForRuntime } from "../src/session/conversation-retention.js";
import type { SessionAcpxState, SessionAgentMessage, SessionConversation } from "../src/types.js";

const TIMESTAMP = "2026-09-25T00:00:00.000Z";

function agentAt(conversation: SessionConversation, index: number): SessionAgentMessage {
  const message = conversation.messages[index];
  assert.ok(message && typeof message === "object" && "Agent" in message);
  return message.Agent;
}

function applyUpdate(
  conversation: SessionConversation,
  update: SessionNotification["update"],
  userMessageId = "explicit-user-id",
  state?: SessionAcpxState,
) {
  return reduceSessionUpdate(
    conversation,
    state,
    { sessionId: "session", update },
    TIMESTAMP,
    userMessageId,
  );
}

test("the shared reducer resolves supplied IDs only when a user message is created", () => {
  const conversation = createConversation(TIMESTAMP);
  let calls = 0;
  const nextId = () => `user-${++calls}`;
  reducePromptSubmission(conversation, [], TIMESTAMP, nextId);
  reduceSessionUpdate(
    conversation,
    undefined,
    {
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    },
    TIMESTAMP,
    nextId,
  );
  assert.equal(calls, 0);
  reducePromptSubmission(conversation, "prompt", TIMESTAMP, nextId);
  reduceSessionUpdate(
    conversation,
    undefined,
    {
      sessionId: "session",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "chunk" } },
    },
    TIMESTAMP,
    nextId,
  );
  assert.equal(calls, 2);
  assert.deepEqual(conversation.messages, [
    { User: { id: "user-1", content: [{ Text: "prompt" }] } },
    { User: { id: "user-2", content: [{ Text: "chunk" }] } },
  ]);
});

test("lossless reducer ignores unknown and prototype-named updates", () => {
  const conversation = createConversation(TIMESTAMP);
  reducePromptSubmission(conversation, "prompt", TIMESTAMP, "prompt-id");
  const state: SessionAcpxState = { current_mode_id: "mode" };
  const beforeConversation = structuredClone(conversation);
  const beforeState = structuredClone(state);
  for (const sessionUpdate of ["unknown_update", "toString", "constructor", "__proto__"]) {
    const update = { sessionUpdate } as unknown as SessionNotification["update"];
    const receipt = applyUpdate(conversation, update, "unused-id", state);
    assert.equal(receipt.messageIndex, undefined, sessionUpdate);
    assert.equal(receipt.acpx, state);
    assert.deepEqual(conversation, beforeConversation);
    assert.deepEqual(state, beforeState);
  }
});

test("lossless mutation receipts identify only actual message updates", () => {
  const conversation = createConversation("before");
  assert.deepEqual(reducePromptSubmission(conversation, [], TIMESTAMP, "unused"), {
    messageIndex: undefined,
  });
  assert.equal(conversation.updated_at, "before");
  assert.deepEqual(reducePromptSubmission(conversation, "prompt", TIMESTAMP, "prompt-id"), {
    messageIndex: 0,
  });
  for (const content of [
    { type: "text", text: "" },
    { type: "image", mimeType: "image/png", data: "AA==" },
  ] as const) {
    assert.equal(
      applyUpdate(conversation, { sessionUpdate: "agent_message_chunk", content }).messageIndex,
      undefined,
    );
  }
  assert.equal(conversation.messages.length, 1);
  for (const text of ["first ", "second"]) {
    assert.equal(
      applyUpdate(conversation, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      }).messageIndex,
      1,
    );
  }
  assert.equal(
    applyUpdate(conversation, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    }).messageIndex,
    1,
  );
  assert.equal(
    applyUpdate(conversation, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      rawInput: { command: "read" },
    }).messageIndex,
    1,
  );
  assert.equal(
    applyUpdate(conversation, { sessionUpdate: "tool_call_update", toolCallId: "tool" })
      .messageIndex,
    undefined,
  );
  assert.equal(
    applyUpdate(conversation, { sessionUpdate: "tool_call_update", toolCallId: "new-tool" })
      .messageIndex,
    1,
  );
  assert.equal(
    applyUpdate(conversation, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "" },
    }).messageIndex,
    2,
  );
  assert.deepEqual(conversation.messages[2], {
    User: { id: "explicit-user-id", content: [{ Text: "" }] },
  });
  assert.equal(
    applyUpdate(conversation, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "after user" },
    }).messageIndex,
    3,
  );
  assert.deepEqual(agentAt(conversation, 1).content.slice(0, 2), [
    { Text: "first second" },
    { Thinking: { text: "thinking", signature: null } },
  ]);
});

test("lossless metadata updates preserve normalization without claiming a message", () => {
  const conversation = createConversation(TIMESTAMP);
  reducePromptSubmission(conversation, "prompt", TIMESTAMP, "prompt-id");
  const state: SessionAcpxState = { current_mode_id: "old" };
  const updates: SessionNotification["update"][] = [
    { sessionUpdate: "current_mode_update", currentModeId: "new" },
    {
      sessionUpdate: "session_info_update",
      title: "Title",
      updatedAt: "2000-01-01T00:00:00.000Z",
    },
    {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "  review  ", description: "  details  ", input: null }],
    },
    {
      sessionUpdate: "usage_update",
      used: 5,
      size: 100,
      cost: { amount: 0.1, currency: "USD" },
      _meta: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    },
    {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "llm",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "model-a",
          options: [{ value: "model-a", name: "Model A" }],
        },
      ],
    },
    { sessionUpdate: "plan", entries: [] },
  ];
  for (const update of updates) {
    const receipt = applyUpdate(conversation, update, "ignored-id", state);
    assert.equal(receipt.messageIndex, undefined);
    assert.equal(receipt.acpx, state);
  }
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.updated_at, TIMESTAMP);
  assert.equal(conversation.title, "Title");
  assert.deepEqual(conversation.cumulative_cost, { amount: 0.1, currency: "USD" });
  assert.equal(conversation.request_token_usage["prompt-id"].total_tokens, 5);
  assert.equal(state.current_mode_id, "new");
  assert.deepEqual(state.available_commands, [
    { name: "review", description: "details", has_input: false },
  ]);
  assert.equal(state.current_model_id, "model-a");
  assert.deepEqual(state.available_model_names, { "model-a": "Model A" });
  const stateClone = cloneSessionAcpxState(state);
  assert.equal(stateClone?.current_mode_id, state.current_mode_id);
  assert.deepEqual(stateClone?.available_model_names, state.available_model_names);
  assert.deepEqual(stateClone?.config_options, state.config_options);
  assert.notEqual(stateClone?.config_options, state.config_options);
});

for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"] as const) {
  test(`lossless ${sessionUpdate} keeps complete chunks while runtime trims each operation`, () => {
    const lossless = createConversation(TIMESTAMP);
    const runtime = createSessionConversation(TIMESTAMP);
    const shadow = createConversation(TIMESTAMP);
    const limit = sessionUpdate === "agent_message_chunk" ? 8_000 : 4_000;
    const first = "😀".repeat(limit / 2 + 1);
    for (const text of [first, "!"]) {
      const notification: SessionNotification = {
        sessionId: "session",
        update: { sessionUpdate, content: { type: "text", text } },
      };
      reduceSessionUpdate(lossless, undefined, notification, TIMESTAMP, "unused");
      reduceSessionUpdate(shadow, undefined, notification, TIMESTAMP, "unused");
      trimConversationForRuntime(shadow);
      recordSessionUpdate(runtime, undefined, notification, TIMESTAMP, "unused");
      assert.deepEqual(shadow, runtime);
    }
    const fullText = first + "!";
    const boundedText = "😀".repeat(limit / 2 - 2) + "...!";
    const content = (text: string) =>
      sessionUpdate === "agent_message_chunk"
        ? [{ Text: text }]
        : [{ Thinking: { text, signature: null } }];
    assert.deepEqual(agentAt(lossless, 0).content, content(fullText));
    assert.deepEqual(agentAt(runtime, 0).content, content(boundedText));
    const oneShot = cloneConversation(lossless);
    trimConversationForRuntime(oneShot);
    assert.notDeepEqual(oneShot, runtime, "checkpoint shadows must trim after each operation");
  });
}

test("lossless tool patches retain full structured values and opaque IDs", () => {
  const conversation = createConversation(TIMESTAMP);
  const rawInput = { text: "😀".repeat(3_000), nested: { original: true } };
  const rawOutput = { text: "x".repeat(9_000), nested: ["kept"] };
  for (const toolCallId of ["__proto__", "constructor", "toString"]) {
    assert.equal(
      applyUpdate(conversation, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "  Original  ",
        status: "failed",
        rawInput,
        rawOutput,
      }).messageIndex,
      0,
    );
    assert.equal(
      applyUpdate(conversation, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Renamed",
      }).messageIndex,
      0,
    );
    const agent = agentAt(conversation, 0);
    const tool = agent.content.find((item) => "ToolUse" in item && item.ToolUse.id === toolCallId);
    assert.ok(tool && "ToolUse" in tool);
    assert.equal(tool.ToolUse.raw_input, JSON.stringify(rawInput));
    assert.deepEqual(tool.ToolUse.input, rawInput);
    assert.notEqual(tool.ToolUse.input, rawInput);
    assert.equal(Object.hasOwn(agent.tool_results, toolCallId), true);
    assert.deepEqual(agent.tool_results[toolCallId], {
      tool_use_id: toolCallId,
      tool_name: "Renamed",
      is_error: true,
      content: { Text: JSON.stringify(rawOutput) },
      output: rawOutput,
    });
    assert.notEqual(agent.tool_results[toolCallId].output, rawOutput);
    applyUpdate(conversation, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
    });
    assert.equal(agent.tool_results[toolCallId].is_error, false);
    assert.deepEqual(agent.tool_results[toolCallId].output, rawOutput);
  }
  const copied = cloneConversation(conversation);
  assert.deepEqual(copied, conversation);
  assert.notEqual(copied.messages, conversation.messages);
  assert.equal(Object.getPrototypeOf(agentAt(conversation, 0).tool_results), Object.prototype);
});

test("lossless tool normalization preserves unserializable-value fallbacks", () => {
  const conversation = createConversation(TIMESTAMP);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [() => undefined, Symbol("opaque"), cyclic]) {
    applyUpdate(conversation, {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Tool",
      rawInput: value,
      rawOutput: value,
    });
    const agent = agentAt(conversation, 0);
    assert.deepEqual(agent.tool_results.tool.content, { Text: "[Unserializable value]" });
    const tool = agent.content[0];
    assert.ok("ToolUse" in tool);
    assert.equal(tool.ToolUse.raw_input, "[Unserializable input]");
  }
});

for (const messageId of ["__proto__", "constructor", "toString"]) {
  for (const source of ["notification", "response"]) {
    test(`${source} usage remains an own serialized entry for ${messageId}`, () => {
      const conversation = createSessionConversation(TIMESTAMP);
      recordPromptResponseUsage(conversation, { outputTokens: 3 }, "neighbor", TIMESTAMP);
      recordPromptSubmission(conversation, "hello", TIMESTAMP, messageId);
      if (source === "notification") {
        recordSessionUpdate(
          conversation,
          undefined,
          {
            sessionId: "session",
            update: {
              sessionUpdate: "usage_update",
              used: 7,
              size: 100,
              _meta: { usage: { outputTokens: 7 } },
            },
          },
          TIMESTAMP,
        );
      } else {
        recordPromptResponseUsage(conversation, { outputTokens: 7 }, messageId, TIMESTAMP);
      }
      const usage = conversation.request_token_usage;
      assert.equal(Object.hasOwn(usage, messageId), true);
      assert.equal(Object.getPrototypeOf(usage), Object.prototype);
      assert.equal(usage[messageId].output_tokens, 7);
      assert.equal(usage.neighbor.output_tokens, 3);
      assert.equal(
        JSON.stringify(usage),
        JSON.stringify(
          Object.fromEntries([
            ["neighbor", { output_tokens: 3 }],
            [messageId, { output_tokens: 7 }],
          ]),
        ),
      );
    });
  }
}

test("lossless prompts, messages, and usage exceed runtime caps without changing runtime bounds", () => {
  const lossless = createConversation(TIMESTAMP);
  const runtime = createSessionConversation(TIMESTAMP);
  const prompt = "p".repeat(9_000);
  for (let index = 0; index < 105; index += 1) {
    const id = `prompt-${index}`;
    assert.equal(reducePromptSubmission(lossless, prompt, TIMESTAMP, id).messageIndex, index * 2);
    assert.equal(recordPromptSubmission(runtime, prompt, TIMESTAMP, id), id);
    const notification: SessionNotification = {
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
    };
    assert.equal(
      reduceSessionUpdate(lossless, undefined, notification, TIMESTAMP, "unused").messageIndex,
      index * 2 + 1,
    );
    recordSessionUpdate(runtime, undefined, notification, TIMESTAMP);
    assert.equal(reducePromptResponseUsage(lossless, { totalTokens: index }, id, TIMESTAMP), true);
    assert.equal(recordPromptResponseUsage(runtime, { totalTokens: index }, id, TIMESTAMP), true);
  }
  assert.equal(lossless.messages.length, 210);
  assert.equal(Object.keys(lossless.request_token_usage).length, 105);
  assert.deepEqual(lossless.messages[0], { User: { id: "prompt-0", content: [{ Text: prompt }] } });
  assert.equal(runtime.messages.length, 200);
  assert.equal(Object.keys(runtime.request_token_usage).length, 100);
  assert.deepEqual(runtime.messages[0], {
    User: { id: "prompt-5", content: [{ Text: "p".repeat(7_997) + "..." }] },
  });
  assert.equal(lossless.request_token_usage["prompt-104"].total_tokens, 104);
  assert.deepEqual(
    runtime.request_token_usage,
    Object.fromEntries(Object.entries(lossless.request_token_usage).slice(-100)),
  );
  const unchanged = cloneConversation(lossless);
  assert.equal(reducePromptResponseUsage(lossless, { totalTokens: -1 }, undefined, "later"), false);
  assert.deepEqual(lossless, unchanged);
});
