import { TimeoutError, withTimeout } from "../../async-control.js";
import {
  hasAgentReplyAfterPrompt,
  recordPromptResponseUsage,
} from "../../session/conversation-model.js";
import type {
  AcpElicitationHandler,
  PromptInput,
  RunPromptResult,
  SessionConversation,
} from "../../types.js";

const SESSION_REPLY_IDLE_MS = 1_000;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5_000;

function responseMetaField(meta: Record<string, unknown> | null | undefined): {
  _meta?: Record<string, unknown> | null;
} {
  return meta === undefined ? {} : { _meta: meta };
}

type PromptTurnClient = {
  prompt: (
    sessionId: string,
    prompt: PromptInput | string,
    onRequestStarted?: () => Promise<void> | void,
    onElicitation?: AcpElicitationHandler,
  ) => Promise<{
    stopReason: RunPromptResult["stopReason"];
    usage?: unknown;
    _meta?: Record<string, unknown> | null;
  }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

type PromptResponse = Awaited<ReturnType<PromptTurnClient["prompt"]>>;

function recoveredSessionResult(
  response: PromptResponse | undefined,
  conversation: SessionConversation,
  promptMessageId: string,
): {
  stopReason: "end_turn";
  source: "session";
  _meta?: Record<string, unknown> | null;
} {
  recordPromptResponseUsage(conversation, response?.usage, promptMessageId);
  return {
    stopReason: "end_turn",
    source: "session",
    ...responseMetaField(response?._meta),
  };
}

export async function runPromptTurn(params: {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation: SessionConversation;
  promptMessageId?: string;
  onPromptRequestStarted?: () => Promise<void> | void;
  onPromptStarted?: () => Promise<void> | void;
  onElicitation?: AcpElicitationHandler;
}): Promise<{
  stopReason: RunPromptResult["stopReason"];
  source: "rpc" | "session";
  _meta?: Record<string, unknown> | null;
}> {
  let settledResponse: PromptResponse | undefined;
  try {
    const promptPromise = params.client.prompt(
      params.sessionId,
      params.prompt,
      params.onPromptRequestStarted,
      params.onElicitation,
    );
    void promptPromise.then(
      (response) => {
        settledResponse = response;
      },
      () => {},
    );
    await params.onPromptStarted?.();
    const response = await withTimeout(promptPromise, params.timeoutMs);
    await params.client
      .waitForSessionUpdatesIdle?.({
        idleMs: SESSION_REPLY_IDLE_MS,
        timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
      })
      .catch(() => {
        // Best effort. The prompt already completed successfully, so keep the
        // original stop reason if late update draining itself times out.
      });
    recordPromptResponseUsage(params.conversation, response.usage, params.promptMessageId);
    return {
      stopReason: response.stopReason,
      source: "rpc",
      ...responseMetaField(response._meta),
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
      return recoveredSessionResult(settledResponse, params.conversation, params.promptMessageId);
    }

    throw error;
  }
}
