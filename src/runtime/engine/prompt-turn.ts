import { TimeoutError, withTimeout } from "../../async-control.js";
import { hasAgentReplyAfterPrompt } from "../../session/conversation-model.js";
import type { PromptInput, RunPromptResult, SessionConversation } from "../../types.js";

const SESSION_REPLY_IDLE_MS = 1_000;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5_000;

type PromptTurnClient = {
  prompt: (
    sessionId: string,
    prompt: PromptInput | string,
  ) => Promise<{ stopReason: RunPromptResult["stopReason"] }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

export async function runPromptTurn(params: {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation: SessionConversation;
  promptMessageId?: string;
  onPromptStarted?: () => Promise<void> | void;
}): Promise<{ stopReason: RunPromptResult["stopReason"]; source: "rpc" | "session" }> {
  try {
    const promptPromise = params.client.prompt(params.sessionId, params.prompt);
    await params.onPromptStarted?.();
    const response = await withTimeout(promptPromise, params.timeoutMs);
    await params.client
      .waitForSessionUpdatesIdle?.({
        idleMs: SESSION_REPLY_IDLE_MS,
        timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
      })
      .catch(() => {
        // Best-effort post-success drain: give the adapter a bounded window to emit any
        // late assistant_delta / tool_call updates that arrive just after client.prompt()
        // resolves, so the prompt turn does not close before those updates are observed.
      });
    return {
      stopReason: response.stopReason,
      source: "rpc",
    };
  } catch (error) {
    if (!(error instanceof TimeoutError) || !params.promptMessageId) {
      throw error;
    }

    await params.client
      .waitForSessionUpdatesIdle?.({
        idleMs: SESSION_REPLY_IDLE_MS,
        timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
      })
      .catch(() => {
        // Best effort. If the update drain itself times out, fall back to the prompt error.
      });

    if (hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId)) {
      return {
        stopReason: "end_turn",
        source: "session",
      };
    }

    throw error;
  }
}
