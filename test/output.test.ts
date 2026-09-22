import assert from "node:assert/strict";
import test from "node:test";
import { extractSessionUpdateNotification } from "../src/acp/jsonrpc.js";
import { createOutputFormatter, getTextErrorRemediationHints } from "../src/cli/output/output.js";

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

function doneResult(stopReason: string, result: Record<string, unknown> = {}): unknown {
  return {
    jsonrpc: "2.0",
    id: "req-1",
    result: {
      stopReason,
      ...result,
    },
  };
}

function errorResult(message: string, details?: string): unknown {
  return {
    jsonrpc: "2.0",
    id: "req-1",
    error: {
      code: -32603,
      message,
      ...(details ? { data: { details } } : {}),
    },
  };
}

for (const format of ["text", "quiet", "json"] as const) {
  test(`${format} formatter exposes permission cancellation notices without changing the response`, () => {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const formatter = createOutputFormatter(format, { stdout, stderr });
    const notice = "Permission cancellation may end the current turn.";
    const message = {
      jsonrpc: "2.0" as const,
      id: "permission",
      result: {
        outcome: { outcome: "selected", optionId: "cancel" },
        _meta: { acpx: { permissionNotice: notice } },
      },
    };
    formatter.onAcpMessage(message);
    formatter.flush();
    if (format === "json") {
      assert.deepEqual(JSON.parse(stdout.toString()), message);
    } else {
      assert.match(
        (format === "quiet" ? stderr : stdout).toString(),
        /Permission cancellation may end the current turn/,
      );
    }
    if (format === "quiet") {
      assert.equal(stdout.toString(), "");
    } else {
      assert.equal(stderr.toString(), "");
    }
  });
}

function sessionUpdate(update: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update,
    },
  };
}

const malformedUpdates = [
  ...["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].flatMap((kind) =>
    [undefined, null, {}, { type: "text" }, { type: "text", text: 1 }].map((content) => ({
      sessionUpdate: kind,
      content,
    })),
  ),
  ...[undefined, null, [null], [{}], [{ status: "pending", content: 1 }]].map((entries) => ({
    sessionUpdate: "plan",
    entries,
  })),
];

test("extractSessionUpdateNotification rejects malformed chunks and plans", () => {
  for (const update of malformedUpdates) {
    assert.equal(extractSessionUpdateNotification(sessionUpdate(update) as never), undefined);
  }
  const valid = extractSessionUpdateNotification(messageChunk("kept") as never);
  assert.equal(valid?.update.sessionUpdate, "agent_message_chunk");
});

test("extractSessionUpdateNotification preserves nontext chunks, empty plans, and extension updates", () => {
  for (const update of [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "", mimeType: "image/png" },
    },
    { sessionUpdate: "plan", entries: [] },
    { sessionUpdate: "vendor_update", value: 1 },
  ]) {
    assert.deepEqual(
      extractSessionUpdateNotification(sessionUpdate(update) as never)?.update,
      update,
    );
  }
});

test("text and quiet formatters keep valid output after malformed chunks and plans", () => {
  for (const format of ["text", "quiet"] as const) {
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const formatter = createOutputFormatter(format, { stdout, stderr });
    for (const update of malformedUpdates) {
      formatter.onAcpMessage(sessionUpdate(update) as never);
    }
    assert.equal(stdout.toString(), "");
    formatter.onAcpMessage(messageChunk("kept") as never);
    formatter.onAcpMessage(doneResult("end_turn") as never);
    formatter.flush();
    assert.match(stdout.toString(), /kept/);
    assert.equal(stderr.toString(), "");
  }
});

test("json output preserves malformed session notifications", () => {
  const stdout = new CaptureWriter();
  const formatter = createOutputFormatter("json", { stdout });
  const message = sessionUpdate({ sessionUpdate: "agent_message_chunk" });
  formatter.onAcpMessage(message as never);
  formatter.flush();
  assert.deepEqual(JSON.parse(stdout.toString()), message);
});

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
  const finalUpdate = {
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
  } satisfies Parameters<typeof formatter.onAcpMessage>[0];
  formatter.onAcpMessage(finalUpdate);
  const firstFinal = writer.toString();
  formatter.onAcpMessage(finalUpdate);
  assert.equal(writer.toString(), firstFinal);
  formatter.onAcpMessage({
    ...finalUpdate,
    params: {
      ...finalUpdate.params,
      update: { ...finalUpdate.params.update, rawOutput: { stdout: "Changed tool output" } },
    },
  });

  const output = writer.toString();
  assert.match(output, /\[tool\] run_command/);
  assert.match(output, /input: npm test/);
  assert.match(output, /All tests passing/);
  assert.match(output, /Changed tool output/);
  assert.equal((output.match(/\(completed\)/g) ?? []).length, 2);
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

test("json formatter keeps remediation hints out of JSON error payloads", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", {
    stdout: writer,
    jsonContext: {
      sessionId: "session-auth",
    },
  });

  formatter.onError({
    code: "RUNTIME",
    detailCode: "AUTH_REQUIRED",
    message: "missing credentials for auth method openai-api-key",
    origin: "acp",
    acp: {
      code: -32000,
      message: "Authentication required",
      data: {
        methodId: "openai-api-key",
      },
    },
  });

  const parsed = JSON.parse(writer.toString().trim()) as {
    error?: {
      message?: string;
      data?: {
        acpxCode?: string;
        detailCode?: string;
      };
    };
  };
  assert.equal(parsed.error?.message, "Authentication required");
  assert.equal(parsed.error?.data?.acpxCode, "RUNTIME");
  assert.equal(parsed.error?.data?.detailCode, "AUTH_REQUIRED");
  assert.doesNotMatch(writer.toString(), /hint:/);
});

test("text formatter prints auth remediation hints", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onError({
    code: "RUNTIME",
    detailCode: "AUTH_REQUIRED",
    message: "missing credentials for auth method openai-api-key",
    origin: "acp",
    acp: {
      code: -32000,
      message: "Authentication required",
      data: {
        methodId: "openai-api-key",
      },
    },
  });

  const output = writer.toString();
  assert.match(output, /\[error\] RUNTIME: missing credentials/);
  assert.match(output, /hint: run `acpx config show`/);
  assert.match(output, /`auth\.openai-api-key`/);
});

test("text remediation hints cover missing session and ACP runtime failures", () => {
  assert.deepEqual(getTextErrorRemediationHints({ code: "NO_SESSION", message: "No session" }), [
    "hint: the saved ACP session is missing or stale; start a fresh session with `acpx <agent> sessions new`, then retry.",
  ]);
  assert.deepEqual(
    getTextErrorRemediationHints({
      code: "TIMEOUT",
      message: "Timed out after 1000ms",
    }),
    [
      "hint: increase `--timeout <seconds>` for long-running prompts, or check whether the agent/provider is stalled.",
    ],
  );
  assert.deepEqual(
    getTextErrorRemediationHints({
      code: "RUNTIME",
      message: "Provider returned 429 rate limit exceeded",
      origin: "acp",
    }),
    [
      "hint: the provider appears rate-limited; retry later, switch model, or check provider quota/billing.",
    ],
  );
  assert.deepEqual(
    getTextErrorRemediationHints({
      code: "RUNTIME",
      message: "model not found: cerebras/qwen-3-coder-480b",
      origin: "acp",
    }),
    [
      "hint: check the configured model name for this agent, then retry with `--model <model>` or `sessions set-model <model>`.",
    ],
  );
  assert.deepEqual(
    getTextErrorRemediationHints({
      code: "RUNTIME",
      message: "Failed session/set_mode for mode plan: Invalid params",
      origin: "acp",
      acp: {
        code: -32602,
        message: "Invalid params",
      },
    }),
    ["hint: rerun with `--verbose` to capture the ACP method/error details before retrying."],
  );
  assert.deepEqual(
    getTextErrorRemediationHints({
      code: "RUNTIME",
      message: "Failed session/set_model for model legacy-model: Invalid params",
      origin: "acp",
      acp: {
        code: -32602,
        message: "Invalid params",
      },
    }),
    ["hint: rerun with `--verbose` to capture the ACP method/error details before retrying."],
  );
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

test("json formatter clears suppressed read tracking after error responses", () => {
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
    id: "req-read-error",
    method: "fs/read_text_file",
    params: {
      sessionId: "session-json",
      path: "/tmp/demo.txt",
    },
  } as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    id: "req-read-error",
    error: {
      code: -32000,
      message: "failed",
    },
  } as never);
  formatter.onAcpMessage({
    jsonrpc: "2.0",
    id: "req-read-error",
    result: {
      content: "visible later response",
    },
  } as never);

  const lines = writer
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(
    (lines[2]?.result as { content?: string } | undefined)?.content,
    "visible later response",
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
        title: "Write README.md",
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

test("quiet formatter drains pending text without sealing an empty or intermediate flush", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });
  formatter.flush();
  assert.equal(writer.toString(), "");
  formatter.onAcpMessage(messageChunk("PARTIAL-π 🦞\nsecond line") as never);
  formatter.flush();
  formatter.flush();
  assert.equal(writer.toString(), "PARTIAL-π 🦞\nsecond line\n");
  formatter.onAcpMessage(messageChunk("later text\n") as never);
  formatter.onAcpMessage(doneResult("end_turn") as never);
  formatter.flush();
  assert.equal(writer.toString(), "PARTIAL-π 🦞\nsecond line\nlater text\n");
});

test("quiet formatter preserves pending text once on terminal error", () => {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });
  formatter.onAcpMessage(messageChunk("partial ") as never);
  formatter.onAcpMessage(errorResult("intermediate callback error") as never);
  assert.equal(stdout.toString(), "");
  formatter.onAcpMessage(messageChunk("answer\n") as never);
  formatter.onError({ code: "RUNTIME", message: "synthetic failure" });
  formatter.flush();
  assert.equal(stdout.toString(), "partial answer\n");
  assert.equal(stderr.toString(), "[acpx] error: RUNTIME synthetic failure\n");
});

test("quiet formatter preserves empty success without duplicating final drains", () => {
  const stdout = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout });
  formatter.flush();
  formatter.onAcpMessage(doneResult("end_turn") as never);
  formatter.flush();
  formatter.onAcpMessage(doneResult("end_turn") as never);
  assert.equal(stdout.toString(), "\n");
});

test("quiet formatter does not append a blank line when completion follows a drain", () => {
  const stdout = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout });
  formatter.onAcpMessage(messageChunk("answer") as never);
  formatter.flush();
  formatter.onAcpMessage(doneResult("end_turn") as never);
  formatter.onAcpMessage(messageChunk("late after success") as never);
  formatter.flush();
  assert.equal(stdout.toString(), "answer\n");
});

test("quiet formatter emits final usage and cost metadata to stderr", () => {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onAcpMessage(messageChunk("OK") as never);
  formatter.onAcpMessage(
    doneResult("end_turn", {
      usage: {
        inputTokens: 17_030,
        outputTokens: 4,
        cachedReadTokens: 12,
        cachedWriteTokens: 3,
        totalTokens: 17_049,
      },
      cost: {
        amount: 0.051276,
        currency: "USD",
      },
    }) as never,
  );

  assert.equal(stdout.toString(), "OK\n");
  assert.equal(
    stderr.toString(),
    "[acpx] tokens: input=17030 output=4 cache_read=12 cache_write=3 total=17049\n[acpx] cost: 0.051276 USD\n",
  );
});

test("quiet formatter ignores non-terminal ACP JSON-RPC errors", () => {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onAcpMessage(errorResult("provider failed") as never);

  assert.equal(stdout.toString(), "");
  assert.equal(stderr.toString(), "");
});

test("quiet formatter emits structured error line to stderr on onError (never swallows errors)", () => {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onError({
    code: "RUNTIME",
    detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
    origin: "queue",
    message: "rate limit exceeded",
  });

  // stdout must remain empty — the quiet contract only covers stdout
  assert.equal(stdout.toString(), "");
  // stderr must contain exactly one structured line, parseable by machines
  assert.equal(
    stderr.toString(),
    "[acpx] error: RUNTIME QUEUE_RUNTIME_PROMPT_FAILED rate limit exceeded\n",
  );
});

test("quiet formatter prefers actionable ACP details on terminal errors", () => {
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stderr });

  formatter.onError({
    code: "RUNTIME",
    message: "Internal error",
    acp: {
      code: -32603,
      message: "Internal error",
      data: { details: "provider quota exceeded" },
    },
  });

  assert.equal(stderr.toString(), "[acpx] error: RUNTIME provider quota exceeded\n");
});

test("quiet formatter onError line uses code when detailCode is absent", () => {
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onError({
    code: "NO_SESSION",
    message: "session not found",
  });

  assert.equal(stdout.toString(), "");
  assert.equal(stderr.toString(), "[acpx] error: NO_SESSION session not found\n");
});

test("quiet formatter onError collapses multi-line message to a single stderr line", () => {
  // A message containing \n would break a line-by-line parser reading stderr.
  // The formatter must squash all newlines before interpolation.
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onError({
    code: "RUNTIME",
    message: "line one\nline two\nline three",
  });

  assert.equal(stdout.toString(), "");
  const stderrStr = stderr.toString();
  // Exactly one non-empty line in the output.
  assert.equal(
    stderrStr.split("\n").filter(Boolean).length,
    1,
    "stderr must be a single line when the message contains embedded newlines",
  );
  assert.equal(stderrStr, "[acpx] error: RUNTIME line one line two line three\n");
});

test("quiet formatter onError collapses CRLF line endings in message to a single stderr line", () => {
  // Windows-style \r\n line endings must be collapsed the same way as \n.
  // A lone \r (old Mac style) is also normalised.
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout, stderr });

  formatter.onError({
    code: "RUNTIME",
    message: "line one\r\nline two\r\nline three",
  });

  assert.equal(stdout.toString(), "");
  const stderrStr = stderr.toString();
  assert.equal(
    stderrStr.split("\n").filter(Boolean).length,
    1,
    "stderr must be a single line when the message contains embedded CRLF newlines",
  );
  assert.equal(stderrStr, "[acpx] error: RUNTIME line one line two line three\n");
});

type SuppressionDirection = "inbound" | "outbound";
type SuppressionMessage = Parameters<ReturnType<typeof createOutputFormatter>["onAcpMessage"]>[0];
type DirectedSuppressionFrame = { direction?: SuppressionDirection; message: SuppressionMessage };

function renderDirectedSuppression(frames: DirectedSuppressionFrame[]): unknown[] {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", { stdout: writer, suppressReads: true });
  // A one-argument baseline method is assignable here and ignores the extra
  // argument at runtime, so the same test exposes the behavior before the fix.
  const emit: (message: SuppressionMessage, direction?: SuppressionDirection) => void =
    formatter.onAcpMessage.bind(formatter);
  for (const frame of frames) {
    emit(frame.message, frame.direction);
  }
  formatter.flush();
  return writer
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

for (const id of [7, "7"] as const) {
  for (const readRequestFirst of [true, false]) {
    for (const readResponseFirst of [true, false]) {
      test(`read suppression separates duplex ${typeof id} ID with request/read-first=${readRequestFirst}, response/read-first=${readResponseFirst}`, () => {
        const readRequest = {
          jsonrpc: "2.0" as const,
          id,
          method: "fs/read_text_file",
          params: { sessionId: "synthetic", path: "/synthetic/file" },
        };
        const controlRequest = {
          jsonrpc: "2.0" as const,
          id,
          method: "session/set_mode",
          params: { sessionId: "synthetic", modeId: "plan" },
        };
        const readResponse = {
          jsonrpc: "2.0" as const,
          id,
          result: { content: "SYNTHETIC_FILE_BODY", _meta: { fixture: "read metadata" } },
        };
        const controlResponse = {
          jsonrpc: "2.0" as const,
          id,
          result: { _meta: { content: "SYNTHETIC_CONTROL_METADATA", direction: "opaque value" } },
        };
        const read: DirectedSuppressionFrame = { direction: "inbound", message: readRequest };
        const control: DirectedSuppressionFrame = {
          direction: "outbound",
          message: controlRequest,
        };
        const readResult: DirectedSuppressionFrame = {
          direction: "outbound",
          message: readResponse,
        };
        const controlResult: DirectedSuppressionFrame = {
          direction: "inbound",
          message: controlResponse,
        };
        const frames = [
          ...(readRequestFirst ? [read, control] : [control, read]),
          ...(readResponseFirst ? [readResult, controlResult] : [controlResult, readResult]),
        ];
        const before = JSON.stringify(frames);
        const output = renderDirectedSuppression(frames);
        assert.deepEqual(
          output,
          frames.map(({ message }) =>
            message === readResponse
              ? {
                  ...readResponse,
                  result: { ...readResponse.result, content: "[read output suppressed]" },
                }
              : message,
          ),
        );
        assert.equal(JSON.stringify(frames), before, "formatting must not mutate protocol input");
      });
    }
  }

  test(`opposite-direction ${typeof id} error does not retire read suppression`, () => {
    const controlRequest = {
      jsonrpc: "2.0" as const,
      id,
      method: "session/set_mode",
      params: { sessionId: "synthetic", modeId: "plan" },
    };
    const readRequest = {
      jsonrpc: "2.0" as const,
      id,
      method: "fs/read_text_file",
      params: { sessionId: "synthetic", path: "/synthetic/file" },
    };
    const controlError = {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: -32602,
        message: "synthetic control refusal",
        data: { content: "CONTROL_ERROR_DATA" },
      },
    };
    const readResponse = {
      jsonrpc: "2.0" as const,
      id,
      result: { content: "SYNTHETIC_FILE_BODY" },
    };
    assert.deepEqual(
      renderDirectedSuppression([
        { direction: "outbound", message: controlRequest },
        { direction: "inbound", message: readRequest },
        { direction: "inbound", message: controlError },
        { direction: "outbound", message: readResponse },
      ]),
      [
        controlRequest,
        readRequest,
        controlError,
        { ...readResponse, result: { content: "[read output suppressed]" } },
      ],
    );
  });
}

test("direction-aware suppression retains numeric/string ID separation within an endpoint", () => {
  const frames: DirectedSuppressionFrame[] = [
    ...[7, "7"].map((id) => ({
      direction: "inbound" as const,
      message: {
        jsonrpc: "2.0" as const,
        id,
        method: "fs/read_text_file",
        params: { sessionId: "synthetic", path: `/synthetic/${typeof id}` },
      },
    })),
    ...[7, "7"].map((id) => ({
      direction: "outbound" as const,
      message: { jsonrpc: "2.0" as const, id, result: { content: `SYNTHETIC_${typeof id}` } },
    })),
  ];
  assert.deepEqual(renderDirectedSuppression(frames), [
    frames[0]?.message,
    frames[1]?.message,
    { jsonrpc: "2.0", id: 7, result: { content: "[read output suppressed]" } },
    { jsonrpc: "2.0", id: "7", result: { content: "[read output suppressed]" } },
  ]);
});

for (const readDirection of ["inbound", undefined] as const) {
  test(`read suppression keeps ${readDirection ?? "legacy"} requests separate from the other metadata namespace`, () => {
    const readRequest = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "fs/read_text_file",
      params: { sessionId: "synthetic", path: "/synthetic/file" },
    };
    const controlRequest = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "session/set_mode",
      params: { sessionId: "synthetic", modeId: "plan" },
    };
    const controlResponse = { jsonrpc: "2.0" as const, id: 7, result: {} };
    const readResponse = {
      jsonrpc: "2.0" as const,
      id: 7,
      result: { content: "SYNTHETIC_FILE_BODY" },
    };
    const controlDirection = readDirection === undefined ? "outbound" : undefined;
    assert.deepEqual(
      renderDirectedSuppression([
        { direction: readDirection, message: readRequest },
        { direction: controlDirection, message: controlRequest },
        {
          direction: controlDirection === undefined ? undefined : "inbound",
          message: controlResponse,
        },
        { direction: readDirection === undefined ? undefined : "outbound", message: readResponse },
      ]),
      [
        readRequest,
        controlRequest,
        controlResponse,
        { ...readResponse, result: { content: "[read output suppressed]" } },
      ],
    );
  });
}
