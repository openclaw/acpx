import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  SESSION_ACP_EVENTS_MAX_ENTRIES,
  createSessionAcpProjection,
  recordClientOperation,
  recordSessionUpdate,
} from "../src/session-acp-projection.js";

test("session ACP projection captures updates and derived state", () => {
  const projection = createSessionAcpProjection();

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    } as SessionNotification,
    "2026-02-27T10:00:00.000Z",
  );

  recordSessionUpdate(
    projection,
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
    "2026-02-27T10:00:01.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } as SessionNotification,
    "2026-02-27T10:00:02.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Run tests",
            status: "in_progress",
            priority: "high",
          },
        ],
      },
    } as SessionNotification,
    "2026-02-27T10:00:03.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "create_plan", description: "create plan" },
          { name: "research_codebase", description: "research codebase" },
        ],
      },
    } as SessionNotification,
    "2026-02-27T10:00:04.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "code",
      },
    } as SessionNotification,
    "2026-02-27T10:00:05.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "My Session",
        updatedAt: "2026-02-27T10:00:05.000Z",
      },
    } as SessionNotification,
    "2026-02-27T10:00:06.000Z",
  );

  recordSessionUpdate(
    projection,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1_000,
        cost: {
          amount: 0.05,
          currency: "USD",
        },
      },
    } as SessionNotification,
    "2026-02-27T10:00:07.000Z",
  );

  recordClientOperation(
    projection,
    {
      method: "terminal/create",
      status: "completed",
      summary: "Ran ls",
      timestamp: "2026-02-27T10:00:08.000Z",
    },
    "2026-02-27T10:00:08.000Z",
  );

  assert.equal(projection.events.length, 9);
  assert.equal(projection.events[0]?.type, "session_update");
  assert.equal(projection.events[8]?.type, "client_operation");

  assert.equal(projection.toolCalls.length, 1);
  assert.equal(projection.toolCalls[0]?.toolCallId, "call_1");
  assert.equal(projection.toolCalls[0]?.status, "completed");
  assert.deepEqual(projection.toolCalls[0]?.rawOutput, { exitCode: 0 });

  assert.deepEqual(projection.plan, [
    {
      content: "Run tests",
      status: "in_progress",
      priority: "high",
    },
  ]);
  assert.deepEqual(projection.availableCommands, ["create_plan", "research_codebase"]);
  assert.equal(projection.currentModeId, "code");
  assert.equal(projection.sessionTitle, "My Session");
  assert.equal(projection.sessionUpdatedAt, "2026-02-27T10:00:05.000Z");
  assert.equal(projection.usage?.used, 100);
  assert.equal(projection.usage?.size, 1_000);
  assert.equal(projection.usage?.costAmount, 0.05);
  assert.equal(projection.usage?.costCurrency, "USD");
});

test("session ACP projection keeps newest events within cap", () => {
  const projection = createSessionAcpProjection();

  for (let index = 0; index < SESSION_ACP_EVENTS_MAX_ENTRIES + 25; index += 1) {
    recordClientOperation(
      projection,
      {
        method: "terminal/output",
        status: "running",
        summary: `event-${index}`,
        timestamp: `2026-02-27T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
      },
      `2026-02-27T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    );
  }

  assert.equal(projection.events.length, SESSION_ACP_EVENTS_MAX_ENTRIES);
  const first = projection.events[0];
  assert.ok(first);
  assert.equal(first.type, "client_operation");
  if (first.type === "client_operation") {
    assert.equal(first.operation.summary, "event-25");
  }
});
