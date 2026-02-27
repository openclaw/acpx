import assert from "node:assert/strict";
import test from "node:test";
import { createOutputFormatter } from "../src/output.js";

class CaptureWriter {
  public readonly chunks: string[] = [];
  public isTTY = false;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function messageChunk(text: string): unknown {
  return {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function thoughtChunk(text: string): unknown {
  return {
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
  };
}

test("text formatter batches thought tokens", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onSessionUpdate(thoughtChunk("Investigating ") as never);
  formatter.onSessionUpdate(thoughtChunk("the issue") as never);
  formatter.onSessionUpdate(messageChunk("Done.") as never);
  formatter.onDone("end_turn");

  const output = writer.toString();
  assert.equal((output.match(/\[thinking\]/g) ?? []).length, 1);
  assert.match(output, /\[thinking\] Investigating the issue/);
});

test("text formatter renders tool calls with input and output", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "run_command",
      status: "in_progress",
      rawInput: { command: "npm", args: ["test"] },
    },
  } as never);

  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "run_command",
      status: "completed",
      rawInput: { command: "npm", args: ["test"] },
      rawOutput: { stdout: "All tests passing" },
    },
  } as never);

  const output = writer.toString();
  assert.match(output, /\[tool\] run_command/);
  assert.match(output, /input: npm test/);
  assert.match(output, /output:/);
  assert.match(output, /All tests passing/);
});

test("json formatter emits canonical NDJSON", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    jsonContext: {
      sessionId: "session-1",
      requestId: "req-1",
      nextSeq: 0,
    },
  });

  formatter.onSessionUpdate(messageChunk("Hello") as never);
  formatter.onSessionUpdate(thoughtChunk("Thinking") as never);
  formatter.onDone("end_turn");

  const lines = writer
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line));

  assert.equal(parsed[0]?.schema, "acpx.event.v1");
  assert.equal(parsed[0]?.session_id, "session-1");
  assert.equal(parsed[0]?.request_id, "req-1");
  assert.equal(parsed[0]?.seq, 0);
  assert.equal(parsed[1]?.seq, 1);
  assert.equal(parsed[2]?.seq, 2);
  assert.equal(parsed[0]?.type, "output_delta");
  assert.equal(parsed[0]?.data?.stream, "output");
  assert.equal(parsed[1]?.type, "output_delta");
  assert.equal(parsed[1]?.data?.stream, "thought");
  assert.equal(parsed[2]?.type, "turn_done");
});

test("text formatter renders client operation updates", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onClientOperation({
    method: "fs/read_text_file",
    status: "completed",
    summary: "read_text_file: /tmp/demo.txt",
    details: "line=1, limit=20",
    timestamp: new Date().toISOString(),
  });

  const output = writer.toString();
  assert.match(output, /\[client\] read_text_file: \/tmp\/demo.txt \(completed\)/);
  assert.match(output, /line=1, limit=20/);
});

test("json formatter emits client operation canonical events", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", { stdout: writer });

  formatter.onClientOperation({
    method: "terminal/create",
    status: "running",
    summary: "terminal/create: node -e \"console.log('hi')\"",
    timestamp: new Date().toISOString(),
  });

  const line = writer.toString().trim();
  const parsed = JSON.parse(line) as {
    type: string;
    data: { method: string; status: string };
  };
  assert.equal(parsed.type, "client_operation");
  assert.equal(parsed.data.method, "terminal/create");
  assert.equal(parsed.data.status, "running");
});

test("json formatter emits structured canonical error events", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    jsonContext: {
      sessionId: "session-error",
      nextSeq: 0,
    },
  });

  formatter.onError({
    code: "PERMISSION_PROMPT_UNAVAILABLE",
    detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
    origin: "queue",
    message: "Permission prompt unavailable in non-interactive mode",
    retryable: false,
    acp: {
      code: -32000,
      message: "Authentication required",
      data: {
        method: "token",
      },
    },
  });

  const line = writer.toString().trim();
  const parsed = JSON.parse(line) as {
    type: string;
    data: {
      code: string;
      detail_code?: string;
      origin?: string;
      message: string;
      retryable?: boolean;
      acp_error?: {
        code: number;
        message: string;
        data?: unknown;
      };
    };
    session_id: string;
    seq: number;
  };
  assert.equal(parsed.type, "error");
  assert.equal(parsed.data.code, "PERMISSION_PROMPT_UNAVAILABLE");
  assert.equal(parsed.data.detail_code, "QUEUE_CONTROL_REQUEST_FAILED");
  assert.equal(parsed.data.origin, "queue");
  assert.equal(
    parsed.data.message,
    "Permission prompt unavailable in non-interactive mode",
  );
  assert.equal(parsed.data.retryable, false);
  assert.equal(parsed.data.acp_error?.code, -32000);
  assert.equal(parsed.session_id, "session-error");
  assert.equal(parsed.seq, 0);
});

test("quiet formatter suppresses non-text output", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onSessionUpdate(thoughtChunk("private") as never);
  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-2",
      title: "read_file",
      status: "completed",
    },
  } as never);
  formatter.onSessionUpdate(messageChunk("Hello ") as never);
  formatter.onSessionUpdate(messageChunk("world") as never);
  formatter.onDone("end_turn");

  assert.equal(writer.toString(), "Hello world\n");
});

test("quiet formatter flushes on turn_done event path", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-1",
    session_id: "session-1",
    seq: 0,
    ts: "2026-02-27T00:00:00.000Z",
    type: "output_delta",
    data: {
      stream: "output",
      text: "Hello ",
    },
  } as never);
  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-2",
    session_id: "session-1",
    seq: 1,
    ts: "2026-02-27T00:00:01.000Z",
    type: "output_delta",
    data: {
      stream: "output",
      text: "world",
    },
  } as never);
  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-3",
    session_id: "session-1",
    seq: 2,
    ts: "2026-02-27T00:00:02.000Z",
    type: "turn_done",
    data: {
      stop_reason: "end_turn",
    },
  } as never);

  assert.equal(writer.toString(), "Hello world\n");
});

test("quiet formatter avoids duplicate flush across turn_done and onDone", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-10",
    session_id: "session-1",
    seq: 0,
    ts: "2026-02-27T00:00:00.000Z",
    type: "output_delta",
    data: {
      stream: "output",
      text: "single",
    },
  } as never);
  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-11",
    session_id: "session-1",
    seq: 1,
    ts: "2026-02-27T00:00:01.000Z",
    type: "turn_done",
    data: {
      stop_reason: "end_turn",
    },
  } as never);
  formatter.onDone("end_turn");

  assert.equal(writer.toString(), "single\n");
});

test("quiet formatter prefers event output when both session updates and events arrive", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onSessionUpdate(messageChunk("dup") as never);
  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-20",
    session_id: "session-1",
    seq: 0,
    ts: "2026-02-27T00:00:00.000Z",
    type: "output_delta",
    data: {
      stream: "output",
      text: "dup",
    },
  } as never);
  formatter.onEvent({
    schema: "acpx.event.v1",
    event_id: "evt-21",
    session_id: "session-1",
    seq: 1,
    ts: "2026-02-27T00:00:01.000Z",
    type: "turn_done",
    data: {
      stop_reason: "end_turn",
    },
  } as never);

  assert.equal(writer.toString(), "dup\n");
});
