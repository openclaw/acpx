import assert from "node:assert/strict";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import {
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";

test("partial assistant text does not complete a timed-out prompt", async () => {
  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  await assert.rejects(
    runPromptTurn({
      client: {
        prompt: () => new Promise(() => {}),
        waitForSessionUpdatesIdle: async () => {
          recordSessionUpdate(conversation, undefined, {
            sessionId: "timeout-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "still working" },
            },
          });
        },
      },
      sessionId: "timeout-session",
      prompt: "hello",
      timeoutMs: 1,
      conversation,
      promptMessageId,
    }),
    TimeoutError,
  );
});

for (const response of [
  { stopReason: "end_turn" as const, usage: { inputTokens: 17 } },
  { stopReason: "cancelled" as const, usage: { inputTokens: 17 }, _meta: null },
  { stopReason: "max_tokens" as const, usage: { inputTokens: 17 }, _meta: { turn: "late" } },
]) {
  test(`late ${response.stopReason} response preserves its outcome without assistant text`, async () => {
    const conversation = createSessionConversation();
    const promptMessageId = recordPromptSubmission(conversation, "hello");
    assert.ok(promptMessageId);
    let resolvePrompt!: (value: typeof response) => void;
    const pending = new Promise<typeof response>((resolve) => {
      resolvePrompt = resolve;
    });
    const result = await runPromptTurn({
      client: {
        prompt: () => pending,
        waitForSessionUpdatesIdle: async () => {
          resolvePrompt(response);
        },
      },
      sessionId: "timeout-session",
      prompt: "hello",
      timeoutMs: 1,
      conversation,
      promptMessageId,
    });
    assert.deepEqual(result, {
      stopReason: response.stopReason,
      source: "session",
      ...(Object.hasOwn(response, "_meta") ? { _meta: response._meta } : {}),
    });
    assert.equal(conversation.request_token_usage[promptMessageId]?.input_tokens, 17);
  });
}
