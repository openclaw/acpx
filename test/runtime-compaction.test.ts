import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
} from "../src/runtime.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type FixtureRuntime = ReturnType<typeof createAcpRuntime>;

async function withRuntime(
  run: (context: { runtime: FixtureRuntime; handle: AcpRuntimeHandle }) => Promise<void>,
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-compaction-"));
  const runtime = createAcpRuntime({
    cwd: rootDir,
    sessionStore: createFileSessionStore({ stateDir: path.join(rootDir, "state") }),
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [process.execPath, MOCK_AGENT_PATH, "--supports-close-session"],
      },
    }),
    permissionMode: "approve-reads",
  });
  const handle = await runtime.ensureSession({
    sessionKey: "compaction-test",
    agent: "fixture",
    mode: "persistent",
  });
  try {
    await run({ runtime, handle });
  } finally {
    await runtime.close({ handle, reason: "test complete", discardPersistentState: true });
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test("runtime streams compaction lifecycle and persists the merged entity", async () => {
  await withRuntime(async ({ runtime, handle }) => {
    const turn = runtime.startTurn({
      handle,
      text: "compaction-demo",
      mode: "prompt",
      requestId: "request-compaction-demo",
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");

    const compactions = events.filter(
      (event): event is Extract<AcpRuntimeEvent, { type: "status" }> =>
        event.type === "status" && event.compaction !== undefined,
    );
    assert.deepEqual(
      compactions.map((event) => [event.tag, event.compaction?.status]),
      [
        ["compaction_update", "in_progress"],
        ["compaction_summary_chunk", "in_progress"],
        ["compaction_update", "completed"],
      ],
    );
    assert.equal(compactions[1]?.compaction?.summary, "Retained context");

    const status = await runtime.getStatus({ handle });
    assert.deepEqual(status.compactions, [
      {
        compactionId: "demo",
        status: "completed",
        summary: "Retained context",
        // User prompt + "before" agent message preceded the compaction.
        afterMessages: 2,
      },
    ]);
  });
});
