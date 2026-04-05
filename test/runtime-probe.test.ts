import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRegistry } from "../src/runtime.js";
import { probeRuntime } from "../src/runtime/public/probe.js";
import { createRuntimeOptions, InMemorySessionStore } from "./runtime-test-helpers.js";

test("probeRuntime uses the default agent override and reports protocol details", async () => {
  const store = new InMemorySessionStore();
  const constructed: Array<Record<string, unknown>> = [];
  const report = await probeRuntime(
    createRuntimeOptions({
      cwd: "/workspace",
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          claude: "broken-claude-acp",
          codex: "codex-override --acp",
        },
      }),
    }),
    {
      clientFactory: (options) => {
        constructed.push(options);
        return {
          initializeResult: { protocolVersion: 1 },
          start: async () => {},
          close: async () => {},
        } as never;
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(constructed[0]?.agentCommand, "codex-override --acp");
  assert.deepEqual(report.details, [
    "agent=codex",
    "command=codex-override --acp",
    "cwd=/workspace",
    "protocolVersion=1",
  ]);
});

test("probeRuntime reports failures and still closes the client", async () => {
  let closed = false;
  const report = await probeRuntime(
    createRuntimeOptions({
      cwd: "/workspace",
      sessionStore: new InMemorySessionStore(),
    }),
    {
      clientFactory: () =>
        ({
          start: async () => {
            throw new Error("spawn failed");
          },
          close: async () => {
            closed = true;
          },
        }) as never,
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.message, "embedded ACP runtime probe failed");
  assert.deepEqual(report.details, [
    "agent=codex",
    "command=codex --acp",
    "cwd=/workspace",
    "spawn failed",
  ]);
  assert.equal(closed, true);
});
