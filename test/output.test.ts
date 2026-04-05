import assert from "node:assert/strict";
import test from "node:test";
import { createOutputFormatter } from "../src/cli/output/output.js";

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
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

function thoughtChunk(text: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  };
}

function doneResult(stopReason: string): unknown {
  return {
    jsonrpc: "2.0",
    id: "req-1",
    result: {
      stopReason,
    },
  };
}

test("text formatter batches thought chunks from ACP notifications", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onAcpMessage(thoughtChunk("Investigating ") as never);
  formatter.onAcpMessage(thoughtChunk("the issue") as never);
  formatter.onAcpMessage(messageChunk("Done.") as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);

  const output = writer.toString();
  assert.equal((output.match(/\[thinking\]/g) ?? []).length, 1);
  assert.match(output, /\[thinking\] Investigating the issue/);
  assert.match(output, /\[done\] end_turn/);
});

test("text formatter preserves line breaks in thought chunks", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onAcpMessage(thoughtChunk("Line one\n\nLine two") as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);

  const output = writer.toString();
  assert.match(output, /\[thinking\] Line one\n\s*\n\s*Line two/);
  assert.doesNotMatch(output, /\[thinking\] Line one Line two/);
});

test("text formatter renders tool call lifecycle from ACP updates", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "run_command",
        status: "in_progress",
        rawInput: { command: "npm", args: ["test"] },
      },
    },
  } as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "run_command",
        status: "completed",
        rawInput: { command: "npm", args: ["test"] },
        rawOutput: { stdout: "All tests passing" },
      },
    },
  } as never);

  const output = writer.toString();
  assert.match(output, /\[tool\] run_command/);
  assert.match(output, /input: npm test/);
  assert.match(output, /All tests passing/);
});

test("json formatter passes through ACP messages", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    jsonContext: {
      sessionId: "session-1",
    },
  });

  const first = messageChunk("hello");
  const second = doneResult("end_turn");
  formatter.onAcpMessage(first as never);
  formatter.onAcpMessage(second as never);

  const lines = writer
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], first);
  assert.deepEqual(lines[1], second);
});

test("json formatter emits ACP JSON-RPC error response from onError", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    jsonContext: {
      sessionId: "session-err",
    },
  });

  formatter.onError({
    code: "RUNTIME",
    message: "adapter failed",
    origin: "runtime",
  });

  const parsed = JSON.parse(writer.toString().trim()) as {
    jsonrpc?: string;
    id?: unknown;
    error?: {
      code?: number;
      message?: string;
      data?: {
        acpxCode?: string;
        origin?: string;
        sessionId?: string;
      };
    };
  };
  assert.equal(parsed.jsonrpc, "2.0");
  assert.equal(parsed.id, null);
  assert.equal(parsed.error?.code, -32603);
  assert.equal(parsed.error?.message, "adapter failed");
  assert.equal(parsed.error?.data?.acpxCode, "RUNTIME");
  assert.equal(parsed.error?.data?.origin, "runtime");
  assert.equal(parsed.error?.data?.sessionId, "session-err");
});

test("text formatter suppresses read output when requested", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer, suppressReads: true });

  formatter.onAcpMessage(messageChunk("assistant text still visible") as never);
  formatter.onAcpMessage(thoughtChunk("thought still visible") as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-read-1",
        title: "Read",
        status: "in_progress",
        rawInput: { filePath: "/tmp/demo.txt" },
      },
    },
  } as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read-1",
        title: "Read",
        kind: "read",
        status: "completed",
        rawInput: { filePath: "/tmp/demo.txt" },
        rawOutput: { content: "secret file body" },
      },
    },
  } as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);

  const output = writer.toString();
  assert.match(output, /assistant text still visible/);
  assert.match(output, /\[thinking\] thought still visible/);
  assert.match(output, /\[tool\] Read/);
  assert.match(output, /\/tmp\/demo.txt/);
  assert.match(output, /\[read output suppressed\]/);
  assert.doesNotMatch(output, /secret file body/);
});

test("json formatter suppresses read output when requested", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    suppressReads: true,
    jsonContext: {
      sessionId: "session-json",
    },
  });

  formatter.onAcpMessage({
    jsonrpc: "2.0",
    id: "req-read-1",
    method: "fs/read_text_file",
    params: {
      sessionId: "session-json",
      path: "/tmp/demo.txt",
    },
  } as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    id: "req-read-1",
    result: {
      content: "secret file body",
    },
  } as never);

  const lines = writer
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(lines.length, 2);
  assert.equal(
    (lines[1]?.result as { content?: string } | undefined)?.content,
    "[read output suppressed]",
  );
});

test("json formatter suppresses read-like tool updates inferred from title", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    suppressReads: true,
    jsonContext: {
      sessionId: "session-json",
    },
  });

  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-json",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read-2",
        title: "Open file",
        status: "completed",
        rawOutput: { content: "secret file body" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "secret file body",
            },
          },
        ],
      },
    },
  } as never);

  const line = JSON.parse(writer.toString().trim()) as {
    params?: {
      update?: {
        rawOutput?: { content?: string };
        content?: Array<{ content?: { text?: string } }>;
      };
    };
  };

  assert.equal(line.params?.update?.rawOutput?.content, "[read output suppressed]");
  assert.equal(line.params?.update?.content?.[0]?.content?.text, "[read output suppressed]");
});

test("json formatter leaves non-read tool updates unchanged with suppression enabled", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    suppressReads: true,
    jsonContext: {
      sessionId: "session-json",
    },
  });

  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-json",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-write-1",
        title: "Write",
        kind: "edit",
        status: "completed",
        rawOutput: { content: "wrote file" },
      },
    },
  } as never);

  const line = JSON.parse(writer.toString().trim()) as {
    params?: {
      update?: {
        rawOutput?: { content?: string };
      };
    };
  };

  assert.equal(line.params?.update?.rawOutput?.content, "wrote file");
});

test("quiet formatter ignores suppress-reads and still outputs assistant text only", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer, suppressReads: true });

  formatter.onAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read-1",
        title: "Read",
        kind: "read",
        status: "completed",
        rawOutput: { content: "secret file body" },
      },
    },
  } as never);
  formatter.onAcpMessage(messageChunk("Hello world") as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);

  assert.equal(writer.toString(), "Hello world\n");
});

test("quiet formatter outputs only agent text and flushes on prompt result", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onAcpMessage(thoughtChunk("private-thought") as never);
  formatter.onAcpMessage(messageChunk("Hello ") as never);
  formatter.onAcpMessage(messageChunk("world") as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);

  assert.equal(writer.toString(), "Hello world\n");
});
