import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAcpRuntime, createAgentRegistry, type AcpSessionRecord } from "../src/runtime.js";

// Reports one tool result through rawOutput and one only through ACP `content`.
const TOOL_AGENT = String.raw`
import readline from "node:readline";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    return out({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  }
  if (message.method === "session/new") {
    return out({ jsonrpc: "2.0", id: message.id, result: { sessionId: "tool-session" } });
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const update = (value) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
    update({ sessionUpdate: "tool_call", toolCallId: "raw-1", title: "Read", kind: "read", status: "pending", rawInput: { path: "a.txt" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "raw-1", status: "completed", rawOutput: { text: "RAW_BODY" } });
    update({ sessionUpdate: "tool_call", toolCallId: "content-1", title: "List", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "content-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "first line" } },
        { type: "content", content: { type: "text", text: "second line" } },
      ],
    });
    return out({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.id !== undefined && message.method) {
    out({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
  }
});
`;

test("saved sessions keep tool results reported through ACP content", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-tool-content-"));
  const agentPath = path.join(rootDir, "tool-agent.mjs");
  await fs.writeFile(agentPath, TOOL_AGENT);
  const saved = new Map<string, AcpSessionRecord>();
  const runtime = createAcpRuntime({
    cwd: rootDir,
    sessionStore: {
      async load(id) {
        const record = saved.get(id);
        return record === undefined ? undefined : structuredClone(record);
      },
      async save(record) {
        saved.set(record.acpxRecordId, structuredClone(record));
      },
    },
    agentRegistry: createAgentRegistry({ overrides: { tool: [process.execPath, agentPath] } }),
    permissionMode: "approve-reads",
  });
  try {
    const handle = await runtime.ensureSession({
      sessionKey: "tool-content",
      agent: "tool",
      mode: "persistent",
    });
    const turn = runtime.startTurn({ handle, text: "go", mode: "prompt", requestId: "tool-turn" });
    const events = [];
    for await (const event of turn.events) {
      events.push(event.type);
    }
    assert.ok(events.length > 0);
    assert.equal((await turn.result).status, "completed");

    const record = [...saved.values()].at(-1);
    assert.ok(record);
    const agent = record.messages.find(
      (message) => typeof message === "object" && message !== null && "Agent" in message,
    ) as { Agent: { tool_results: Record<string, { content: unknown; output?: unknown }> } };
    const results = agent.Agent.tool_results;
    assert.deepEqual(results["raw-1"]?.content, { Text: JSON.stringify({ text: "RAW_BODY" }) });
    assert.deepEqual(results["raw-1"]?.output, { text: "RAW_BODY" });
    assert.deepEqual(results["content-1"]?.content, { Text: "first line\nsecond line" });
    assert.equal(results["content-1"]?.output, undefined);
  } finally {
    await runtime.shutdown();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
