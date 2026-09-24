import assert from "node:assert/strict";
import test from "node:test";
import { recordSessionUpdate } from "../src/session/conversation-model.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type {
  SessionAgentMessage,
  SessionNotification,
  SessionRecord,
  SessionToolResult,
} from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function createRecord(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "conversation-lossless",
    acpSessionId: "conversation-lossless",
    agentCommand: "synthetic-agent",
    agentArgv: ["synthetic-agent"],
    cwd: process.cwd(),
  });
}

function update(record: SessionRecord, value: SessionNotification["update"]): void {
  record.acpx = recordSessionUpdate(
    record,
    record.acpx,
    { sessionId: record.acpSessionId, update: value },
    TIMESTAMP,
  );
}

function roundTrip(record: SessionRecord): SessionRecord {
  const raw: unknown = JSON.parse(JSON.stringify(serializeSessionRecordForDisk(record)));
  const restored = parseSessionRecord(raw);
  assert.ok(restored, "the exact serialized conversation must remain parseable");
  return restored;
}

function agentMessage(record: SessionRecord): SessionAgentMessage {
  assert.equal(record.messages.length, 1);
  const message = record.messages[0];
  assert.ok(typeof message === "object" && message !== null && "Agent" in message);
  return message.Agent;
}

for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"] as const) {
  const content = (text: string) =>
    sessionUpdate === "agent_message_chunk"
      ? [{ Text: text }]
      : [{ Thinking: { text, signature: null } }];

  test(`${sessionUpdate} preserves separate spaces, newlines, and indentation through reload`, () => {
    let record = createRecord();
    for (const text of ["", " ", "Hello", " ", "world", "\n", "\t", "  ", "next", " ", ""]) {
      update(record, { sessionUpdate, content: { type: "text", text } });
    }
    assert.deepEqual(agentMessage(record).content, content(" Hello world\n\t  next "));
    record = roundTrip(record);
    assert.deepEqual(agentMessage(record).content, content(" Hello world\n\t  next "));

    for (const text of ["\n", "  ", "continued", ""]) {
      update(record, { sessionUpdate, content: { type: "text", text } });
    }
    assert.deepEqual(agentMessage(record).content, content(" Hello world\n\t  next \n  continued"));
    assert.deepEqual(
      agentMessage(roundTrip(record)).content,
      content(" Hello world\n\t  next \n  continued"),
    );
  });

  test(`${sessionUpdate} preserves a whitespace-only response through reload`, () => {
    const record = createRecord();
    for (const text of [" ", "\n", "\t  "]) {
      update(record, { sessionUpdate, content: { type: "text", text } });
    }
    assert.deepEqual(agentMessage(record).content, content(" \n\t  "));
    assert.deepEqual(agentMessage(roundTrip(record)).content, content(" \n\t  "));
  });

  test(`${sessionUpdate} still ignores empty chunks without creating an agent message`, () => {
    const record = createRecord();
    update(record, { sessionUpdate, content: { type: "text", text: "" } });
    update(record, { sessionUpdate, content: { type: "text", text: "" } });
    assert.deepEqual(record.messages, []);
    assert.deepEqual(roundTrip(record).messages, []);
  });
}

for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"] as const) {
  test(`${sessionUpdate} truncates emoji without splitting a surrogate pair`, () => {
    const record = createRecord();
    update(record, { sessionUpdate, content: { type: "text", text: "😀".repeat(5_000) } });
    const serialized = JSON.stringify(serializeSessionRecordForDisk(record));
    assert.doesNotMatch(serialized, /\\u[dD][89aAbB][0-9a-fA-F]{2}/);
    const entry = agentMessage(roundTrip(record)).content[0];
    const text = "Text" in entry ? entry.Text : "Thinking" in entry ? entry.Thinking.text : "";
    assert.ok(text.endsWith("😀..."), text.slice(-10));
    assert.ok(text.length <= (sessionUpdate === "agent_message_chunk" ? 8_000 : 4_000));
  });
}

test("tool input and output truncation preserve Unicode through serialization", () => {
  const record = createRecord();
  update(record, {
    sessionUpdate: "tool_call",
    toolCallId: "emoji-tool",
    title: "Synthetic",
    status: "completed",
    rawInput: "😀".repeat(3_000),
    rawOutput: "😀".repeat(3_000),
  });
  const serialized = JSON.stringify(serializeSessionRecordForDisk(record));
  assert.doesNotMatch(serialized, /\\u[dD][89aAbB][0-9a-fA-F]{2}/);
  const agent = agentMessage(roundTrip(record));
  const tool = agent.content.find((entry) => "ToolUse" in entry);
  assert.ok(tool && "ToolUse" in tool);
  assert.ok(tool.ToolUse.raw_input.endsWith("😀..."));
  const output = agent.tool_results["emoji-tool"].output;
  assert.equal(typeof output, "string");
  assert.ok(typeof output === "string" && output.endsWith("😀..."));
});

function assertToolResult(
  record: SessionRecord,
  toolCallId: string,
  expected: Omit<SessionToolResult, "tool_use_id">,
): void {
  const agent = agentMessage(record);
  assert.equal(Object.hasOwn(agent.tool_results, toolCallId), true);
  assert.deepEqual(new Set(Object.keys(agent.tool_results)), new Set(["neighbor", toolCallId]));
  const actual = agent.tool_results[toolCallId];
  assert.equal(actual.tool_use_id, toolCallId);
  assert.equal(actual.tool_name, expected.tool_name);
  assert.equal(actual.is_error, expected.is_error);
  assert.deepEqual(actual.content, expected.content);
  assert.deepEqual(actual.output, expected.output);
  assert.deepEqual(agent.tool_results.neighbor, {
    tool_use_id: "neighbor",
    tool_name: "Neighbor",
    is_error: false,
    content: { Text: "unchanged" },
    output: "unchanged",
  });
  assert.equal(agent.content.length, 2);
  assert.equal(
    agent.content.filter((entry) => "ToolUse" in entry && entry.ToolUse.id === toolCallId).length,
    1,
  );
}

for (const toolCallId of ["ordinary", "constructor", "toString", "__proto__"]) {
  test(`tool result ${toolCallId} remains an own entry across updates and checkpoint reloads`, () => {
    let record = createRecord();
    update(record, {
      sessionUpdate: "tool_call",
      toolCallId: "neighbor",
      title: "Neighbor",
      kind: "other",
      status: "completed",
      rawOutput: "unchanged",
    });
    update(record, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Synthetic tool",
      kind: "other",
      status: "in_progress",
      rawInput: { query: "fixture" },
    });
    const initial = {
      tool_name: "Synthetic tool",
      is_error: false,
      content: { Text: "" },
    };
    assertToolResult(record, toolCallId, initial);
    record = roundTrip(record);
    assertToolResult(record, toolCallId, initial);

    update(record, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { answer: "one", lines: ["a", "b"] },
    });
    const completed = {
      tool_name: "Synthetic tool",
      is_error: false,
      content: { Text: '{"answer":"one","lines":["a","b"]}' },
      output: { answer: "one", lines: ["a", "b"] },
    };
    assertToolResult(record, toolCallId, completed);
    record = roundTrip(record);
    assertToolResult(record, toolCallId, completed);

    update(record, { sessionUpdate: "tool_call_update", toolCallId, title: "Renamed tool" });
    assertToolResult(record, toolCallId, { ...completed, tool_name: "Renamed tool" });
    record = roundTrip(record);
    assertToolResult(record, toolCallId, { ...completed, tool_name: "Renamed tool" });

    update(record, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      rawOutput: "follow-up\n  failed",
    });
    const failed = {
      tool_name: "Renamed tool",
      is_error: true,
      content: { Text: "follow-up\n  failed" },
      output: "follow-up\n  failed",
    };
    assertToolResult(record, toolCallId, failed);
    record = roundTrip(record);
    assertToolResult(record, toolCallId, failed);

    update(record, { sessionUpdate: "tool_call_update", toolCallId, title: "Failure details" });
    const renamedFailure = { ...failed, tool_name: "Failure details" };
    assertToolResult(record, toolCallId, renamedFailure);
    record = roundTrip(record);
    update(record, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      rawOutput: "more failure details",
    });
    const revisedFailure = {
      ...renamedFailure,
      content: { Text: "more failure details" },
      output: "more failure details",
    };
    assertToolResult(record, toolCallId, revisedFailure);
    record = roundTrip(record);
    update(record, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    assertToolResult(record, toolCallId, { ...revisedFailure, is_error: false });
    assertToolResult(roundTrip(record), toolCallId, { ...revisedFailure, is_error: false });
  });
}
