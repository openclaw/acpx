import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createAgentRegistry,
  type AcpPermissionDecision,
} from "../src/runtime.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("public runtime returns exact permission option IDs to the agent", async () => {
  await withTempDir("acpx-permission-options-", async (cwd) => {
    let callbackInvocations = 0;
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: new InMemorySessionStore(),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, MOCK_AGENT_PATH] },
      }),
      permissionMode: "approve-all",
      onPermissionRequest: async () => {
        throw new Error("the per-turn callback should override this handler");
      },
    });
    try {
      const handle = await runtime.ensureSession({
        sessionKey: "permission-options",
        agent: "fixture",
        mode: "persistent",
      });
      const scenarios: Array<{ decision: AcpPermissionDecision; expected: string }> = [
        {
          decision: { outcome: "selected", optionId: "allow-alternative" },
          expected: "permission selected:allow-alternative",
        },
        {
          decision: { outcome: "selected", optionId: "reject" },
          expected: "permission selected:reject",
        },
        {
          decision: { outcome: "selected", optionId: "missing" },
          expected: "permission cancelled",
        },
        {
          decision: { outcome: "allow_once" },
          expected: "permission selected:allow",
        },
        {
          decision: { outcome: "allow_always" },
          expected: "permission selected:allow",
        },
        { decision: { outcome: "cancel" }, expected: "permission cancelled" },
      ];
      for (const [index, { decision, expected }] of scenarios.entries()) {
        const turn = runtime.startTurn({
          handle,
          mode: "prompt",
          requestId: `permission-option-${index}`,
          text: "permission-options execute example command",
          onPermissionRequest: async (request) => {
            callbackInvocations += 1;
            assert.deepEqual(
              request.raw.options.map(({ optionId, kind }) => ({ optionId, kind })),
              [
                { optionId: "allow", kind: "allow_once" },
                { optionId: "allow-alternative", kind: "allow_once" },
                { optionId: "reject", kind: "reject_once" },
              ],
            );
            return decision;
          },
        });
        let text = "";
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            text += event.text;
          }
        }
        assert.equal(text, expected);
        const result = await turn.result;
        assert.equal(result.status, "completed", JSON.stringify(result));
      }
      assert.equal(callbackInvocations, scenarios.length);
    } finally {
      await runtime.shutdown();
    }
  });
});
