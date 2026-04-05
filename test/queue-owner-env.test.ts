import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQueueOwnerPayload, runQueueOwnerFromEnv } from "../src/cli/queue/owner-env.js";

describe("parseQueueOwnerPayload", () => {
  it("parses valid payload", () => {
    const parsed = parseQueueOwnerPayload(
      JSON.stringify({
        sessionId: "session-1",
        permissionMode: "approve-reads",
        mcpServers: [
          {
            name: "linear-http",
            type: "http",
            url: "https://example.com/mcp",
          },
          {
            name: "local-stdio",
            type: "stdio",
            command: "./bin/mcp-local",
            args: ["--serve"],
          },
        ],
        ttlMs: 1234,
        maxQueueDepth: 7,
      }),
    );
    assert.equal(parsed.sessionId, "session-1");
    assert.equal(parsed.permissionMode, "approve-reads");
    assert.equal(parsed.ttlMs, 1234);
    assert.equal(parsed.maxQueueDepth, 7);
    assert.deepEqual(parsed.mcpServers, [
      {
        name: "linear-http",
        type: "http",
        url: "https://example.com/mcp",
        headers: [],
        _meta: undefined,
      },
      {
        name: "local-stdio",
        command: "./bin/mcp-local",
        args: ["--serve"],
        env: [],
        _meta: undefined,
      },
    ]);
    assert.equal(parsed.maxQueueDepth, 7);
  });

  it("rejects invalid payloads", () => {
    assert.throws(() => parseQueueOwnerPayload("{}"), {
      message: "queue owner payload missing sessionId",
    });
    assert.throws(
      () =>
        parseQueueOwnerPayload(
          JSON.stringify({
            sessionId: "session-1",
            permissionMode: "invalid",
          }),
        ),
      {
        message: "queue owner payload has invalid permissionMode",
      },
    );
    assert.throws(
      () =>
        parseQueueOwnerPayload(
          JSON.stringify({
            sessionId: "session-1",
            permissionMode: "approve-all",
            mcpServers: [{ name: "broken", type: "http", url: 123 }],
          }),
        ),
      {
        message: /Invalid mcpServers\[0\] in queue owner payload\.url: expected non-empty string/,
      },
    );
  });
});

describe("runQueueOwnerFromEnv", () => {
  it("fails when payload env is missing", async () => {
    await assert.rejects(async () => await runQueueOwnerFromEnv({}), {
      message: "missing ACPX_QUEUE_OWNER_PAYLOAD",
    });
  });
});
