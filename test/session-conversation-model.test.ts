import assert from "node:assert/strict";
import test from "node:test";
import { modelStateFromConfigOptions } from "../src/acp/model-support.js";
import { mergeConnectedModelState } from "../src/cli/session/runtime.js";
import { applyConfigOptionsToState } from "../src/session/config-options.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import type { SessionAcpxState } from "../src/types.js";

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
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
        cost: { amount: 0.051, currency: "USD" },
        _meta: {
          usage: {
            inputTokens: 60,
            outputTokens: 40,
            cachedWriteTokens: 10,
            cachedReadTokens: 15,
            thoughtTokens: 5,
            totalTokens: 120,
          },
        },
      },
    },
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
    thought_tokens: 5,
    total_tokens: 120,
  });
  assert.deepEqual(conversation.cumulative_token_usage, {
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 15,
    thought_tokens: 5,
    total_tokens: 120,
  });
  assert.deepEqual(conversation.cumulative_cost, { amount: 0.051, currency: "USD" });

  assert.equal(acpxState?.current_mode_id, "code");
  assert.deepEqual(acpxState?.available_commands, [
    { name: "create_plan", description: "create plan", has_input: false },
  ]);
});

test("config option updates synchronize and clear advertised model state", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  let acpxState: SessionAcpxState = {
    current_model_id: "legacy-model",
    available_models: ["legacy-model"],
  };

  acpxState = recordSessionUpdate(conversation, acpxState, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "llm",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "smart-model",
          options: [
            { value: "fast-model", name: "Fast" },
            { value: "smart-model", name: "Smart" },
          ],
        },
      ],
    },
  });

  assert.equal(acpxState.current_model_id, "smart-model");
  assert.deepEqual(acpxState.available_models, ["fast-model", "smart-model"]);

  acpxState = recordSessionUpdate(conversation, acpxState, {
    sessionId: "session-1",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [],
    },
  });

  assert.equal(acpxState.current_model_id, undefined);
  assert.equal(acpxState.available_models, undefined);
});

test("config responses clear stale config models without erasing legacy model control", () => {
  const cleared = applyConfigOptionsToState(
    {
      current_model_id: "smart-model",
      available_models: ["smart-model"],
      model_control: "config_option",
    },
    [],
  );
  assert.equal(cleared.current_model_id, undefined);
  assert.equal(cleared.available_models, undefined);
  assert.equal(cleared.model_control, undefined);

  const legacy = applyConfigOptionsToState(
    {
      current_model_id: "legacy-model",
      available_models: ["legacy-model"],
      model_control: "legacy_set_model",
    },
    [],
  );
  assert.equal(legacy.current_model_id, "legacy-model");
  assert.deepEqual(legacy.available_models, ["legacy-model"]);
  assert.equal(legacy.model_control, "legacy_set_model");

  const migratedLegacy = applyConfigOptionsToState(
    {
      current_model_id: "legacy-model",
      available_models: ["legacy-model"],
    },
    [
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        type: "select",
        currentValue: "medium",
        options: [{ value: "medium", name: "Medium" }],
      },
    ],
  );
  assert.equal(migratedLegacy.current_model_id, "legacy-model");
  assert.equal(migratedLegacy.model_control, "legacy_set_model");

  const migratedConfig = applyConfigOptionsToState(
    {
      current_model_id: "config-model",
      available_models: ["config-model"],
      config_options: [
        {
          id: "llm",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "config-model",
          options: [{ value: "config-model", name: "Config Model" }],
        },
      ],
    },
    [],
  );
  assert.equal(migratedConfig.current_model_id, undefined);
  assert.equal(migratedConfig.model_control, undefined);
});

test("model config parsing ignores malformed raw and persisted snapshots", () => {
  assert.equal(
    modelStateFromConfigOptions([
      {
        id: "llm",
        name: "Model",
        category: "model",
        type: "select",
      },
    ]),
    undefined,
  );
  assert.equal(
    modelStateFromConfigOptions([
      {
        id: "llm",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "smart-model",
        options: [{ group: "recommended", name: "Recommended", options: [null] }],
      },
    ]),
    undefined,
  );
});

test("connected model state propagates authoritative removals", () => {
  const merged = mergeConnectedModelState(
    {
      current_model_id: "stale-model",
      available_models: ["stale-model"],
      model_control: "config_option",
      config_options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "stale-model",
          options: [{ value: "stale-model", name: "Stale Model" }],
        },
      ],
    },
    {},
  );
  assert.equal(merged?.current_model_id, undefined);
  assert.equal(merged?.available_models, undefined);
  assert.equal(merged?.model_control, undefined);
  assert.equal(merged?.config_options, undefined);
});

test("recordPromptSubmission preserves audio prompt content", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");

  const messageId = recordPromptSubmission(
    conversation,
    [
      { type: "text", text: "transcribe" },
      { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
    ],
    "2026-02-27T10:00:01.000Z",
  );

  assert.equal(typeof messageId, "string");
  assert.deepEqual(conversation.messages, [
    {
      User: {
        id: messageId,
        content: [
          { Text: "transcribe" },
          {
            Audio: {
              source: "UklGRg==",
              mime_type: "audio/wav",
            },
          },
        ],
      },
    },
  ]);
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

test("cloneSessionAcpxState preserves desired mode id", () => {
  const cloned = cloneSessionAcpxState({
    current_mode_id: "auto",
    desired_mode_id: "plan",
    desired_config_options: {
      reasoning_effort: "high",
    },
    available_commands: [{ name: "review", description: "Review changes", has_input: true }],
    session_options: {
      model: "sonnet",
      allowed_tools: ["Read", "Grep"],
      max_turns: 7,
    },
  });

  assert.equal(cloned?.current_mode_id, "auto");
  assert.equal(cloned?.desired_mode_id, "plan");
  assert.deepEqual(cloned?.desired_config_options, {
    reasoning_effort: "high",
  });
  assert.deepEqual(cloned?.available_commands, [
    { name: "review", description: "Review changes", has_input: true },
  ]);
  assert.deepEqual(cloned?.session_options, {
    model: "sonnet",
    allowed_tools: ["Read", "Grep"],
    max_turns: 7,
  });
});
