import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeHandle,
} from "../src/runtime.js";
import { withTempHome } from "./runtime-test-helpers.js";

const AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type Control = (
  runtime: ReturnType<typeof createAcpRuntime>,
  handle: AcpRuntimeHandle,
) => Promise<unknown>;

function hasDetailCode(error: unknown, detailCode: string): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ((current as { detailCode?: unknown }).detailCode === detailCode) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function controlAfterCancelledFirstPrompt(control: Control): Promise<void> {
  await withTempHome("acpx-offline-control-", async (home) => {
    const store = createFileSessionStore({ stateDir: `${home}/.acpx` });
    const options = {
      cwd: home,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          mock: [
            process.execPath,
            AGENT,
            "--supports-load-session",
            "--load-session-fails-on-empty",
            "--advertise-config-options",
          ],
        },
      }),
      permissionMode: "deny-all" as const,
    };
    const runtime = createAcpRuntime(options);
    const handle = await runtime.ensureSession({
      sessionKey: "control-after-cancel",
      agent: "mock",
      mode: "persistent",
    });
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const first = runtime.startTurn({
      handle,
      text: "sleep 10000",
      requestId: "first",
      mode: "prompt",
    });
    await first.promptStarted;
    await runtime.cancel({ handle, reason: "test cancellation before agent output" });
    assert.equal((await first.result).status, "cancelled");
    await runtime.shutdown();
    const before = await store.load(recordId);
    assert.ok(before);

    const restarted = createAcpRuntime(options);
    try {
      await assert.rejects(control(restarted, handle), (error: unknown) =>
        hasDetailCode(error, "SESSION_RESUME_REQUIRED"),
      );
    } finally {
      await restarted.shutdown();
    }
    const after = await store.load(recordId);
    assert.equal(after?.acpSessionId, before.acpSessionId);
  });
}

test(
  "offline setMode after a cancelled first prompt refuses to replace the session",
  { timeout: 20_000 },
  async () => {
    await controlAfterCancelledFirstPrompt((runtime, handle) =>
      runtime.setMode({ handle, mode: "plan" }),
    );
  },
);

test(
  "offline setModel after a cancelled first prompt refuses to replace the session",
  { timeout: 20_000 },
  async () => {
    await controlAfterCancelledFirstPrompt((runtime, handle) =>
      runtime.setModel({ handle, model: "fast-model" }),
    );
  },
);

test(
  "offline setConfigOption after a cancelled first prompt refuses to replace the session",
  { timeout: 20_000 },
  async () => {
    await controlAfterCancelledFirstPrompt((runtime, handle) =>
      runtime.setConfigOption({ handle, key: "reasoning_effort", value: "high" }),
    );
  },
);
