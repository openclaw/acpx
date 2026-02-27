import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  SESSION_ACPX_AUDIT_MAX_ENTRIES,
  createSessionThread,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session-thread-model.js";

test("thread model captures prompt, chunks, tool calls, and metadata", () => {
  const thread = createSessionThread("2026-02-27T10:00:00.000Z");
  let acpxState = undefined;

  recordPromptSubmission(thread, "hello", "2026-02-27T10:00:00.000Z");

  acpxState = recordSessionUpdate(
    thread,
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
    thread,
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
    thread,
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
    thread,
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
    thread,
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
    thread,
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
    thread,
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
    thread,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
        cost: {
          amount: 0.05,
          currency: "USD",
        },
      },
    } as SessionNotification,
    "2026-02-27T10:00:07.000Z",
  );

  acpxState = recordClientOperation(
    thread,
    acpxState,
    {
      method: "terminal/create",
      status: "completed",
      summary: "Ran ls",
      timestamp: "2026-02-27T10:00:08.000Z",
    },
    "2026-02-27T10:00:08.000Z",
  );

  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[0]?.kind, "user");
  assert.equal(thread.messages[1]?.kind, "agent");
  assert.equal(thread.title, "My Session");

  const agent = thread.messages[1];
  assert.ok(agent && agent.kind === "agent");
  if (agent && agent.kind === "agent") {
    const tool = agent.content.find(
      (entry) => entry.type === "tool_use" && entry.id === "call_1",
    );
    assert.ok(tool);
    assert.equal(agent.tool_results?.call_1?.tool_name, "Run ls");
    assert.deepEqual(agent.tool_results?.call_1?.output, { exitCode: 0 });
  }

  assert.equal(thread.request_token_usage?.used, 100);
  assert.equal(thread.request_token_usage?.size, 1000);
  assert.equal(acpxState?.current_mode_id, "code");
  assert.deepEqual(acpxState?.available_commands, ["create_plan"]);
  assert.equal(acpxState?.audit_events?.length, 9);
});

test("thread model caps audit events", () => {
  const thread = createSessionThread();
  let state = undefined;

  for (let index = 0; index < SESSION_ACPX_AUDIT_MAX_ENTRIES + 10; index += 1) {
    state = recordClientOperation(
      thread,
      state,
      {
        method: "terminal/output",
        status: "running",
        summary: `event-${index}`,
        timestamp: `2026-02-27T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
      },
      `2026-02-27T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    );
  }

  assert.equal(state?.audit_events?.length, SESSION_ACPX_AUDIT_MAX_ENTRIES);
  assert.equal(state?.audit_events?.[0]?.type, "client_operation");
});
