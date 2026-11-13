import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry, type AcpQuestionHandler } from "../src/runtime.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const AGENT_PATH = fileURLToPath(
  new URL("./fixtures/antigravity-question-agent.js", import.meta.url),
);

test("public runtime questions support defaults and per-turn overrides without tool approvals", async () => {
  await withTempDir("acpx-questions-", async (cwd) => {
    let defaultCalls = 0;
    let overrideCalls = 0;
    const override: AcpQuestionHandler = async (request, { signal }) => {
      overrideCalls += 1;
      assert.equal(request.sessionId, "question-session");
      assert.equal(signal.aborted, false);
      return { outcome: "selected", optionId: "staging" };
    };
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: new InMemorySessionStore(),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, AGENT_PATH] },
      }),
      permissionMode: "approve-all",
      onPermissionRequest: async () => assert.fail("questions must not trigger approvals"),
      onQuestionRequest: async () => {
        defaultCalls += 1;
        return { outcome: "selected", optionId: "production" };
      },
    });
    try {
      const handle = await runtime.ensureSession({
        sessionKey: "questions",
        agent: "fixture",
        mode: "persistent",
      });
      for (const [index, onQuestionRequest] of [undefined, override, undefined].entries()) {
        const turn = runtime.startTurn({
          handle,
          mode: "prompt",
          requestId: `question-${index}`,
          text: "Choose",
          onQuestionRequest,
        });
        let text = "";
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            text += event.text;
          }
        }
        assert.equal(text, onQuestionRequest ? "staging" : "production");
        assert.equal((await turn.result).status, "completed");
      }
      let runText = "";
      for await (const event of runtime.runTurn({
        handle,
        mode: "prompt",
        requestId: "question-run",
        text: "Choose",
        onQuestionRequest: override,
      })) {
        if (event.type === "text_delta") {
          runText += event.text;
        }
      }
      assert.equal(runText, "staging");
      assert.equal(defaultCalls, 2);
      assert.equal(overrideCalls, 2);
    } finally {
      await runtime.shutdown();
    }
  });
});
