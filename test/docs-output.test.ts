import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = ["skills/acpx/SKILL.md", "docs/CLI.md", "docs/index.md"];

test("documented jq pipelines select raw ACP tool calls and sparse updates", (t) => {
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  if (jq.error && "code" in jq.error && jq.error.code === "ENOENT") {
    t.skip("jq is required to execute the documented automation examples");
    return;
  }
  assert.equal(jq.status, 0, jq.stderr);

  const updates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
    { sessionUpdate: "tool_call", toolCallId: "read-1", status: "in_progress", title: "Read" },
    { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
    { sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "Read README" },
    { sessionUpdate: "tool_call_update", toolCallId: "read-1", content: [] },
  ];
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
    ...updates.map((update) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1", update },
    })),
    { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } },
  ];
  const input = frames.map((frame) => JSON.stringify(frame)).join("\n");

  for (const doc of docs) {
    const source = readFileSync(doc, "utf8");
    const filters = [...source.matchAll(/\| jq -r '([^']+)'/g)];
    assert.equal(filters.length, 1, `${doc}: expected one automation pipeline`);
    const result = spawnSync("jq", ["-r", filters[0][1]], { input, encoding: "utf8" });
    assert.equal(result.status, 0, `${doc}: ${result.stderr}`);
    assert.equal(result.stdout, "in_progress\tRead\ncompleted\t-\n-\tRead README\n-\t-\n", doc);
  }
});
