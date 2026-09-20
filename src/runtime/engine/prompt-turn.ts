import {
  assertControlAuthority,
  TimeoutError,
  withTimeout,
  type AcpControlAuthority,
} from "../../async-control.js";
import { recordPromptResponseUsage } from "../../session/conversation-model.js";
import type {
  AcpElicitationHandler,
  AcpPermissionHandler,
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
    onRequestWritten?: () => Promise<void> | void,
    onElicitation?: AcpElicitationHandler,
    onPermissionRequest?: AcpPermissionHandler,
    authority?: AcpControlAuthority,
  ) => Promise<{
    stopReason: RunPromptResult["stopReason"];
    usage?: unknown;
    _meta?: Record<string, unknown> | null;
  }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

type PromptResponse = Awaited<ReturnType<PromptTurnClient["prompt"]>>;

function recoveredSessionResult(
  response: PromptResponse,
  conversation: SessionConversation,
  promptMessageId: string,
): {
  stopReason: PromptResponse["stopReason"];
  source: "session";
  _meta?: Record<string, unknown> | null;
} {
  recordPromptResponseUsage(conversation, response.usage, promptMessageId);
  return {
    stopReason: response.stopReason,
    source: "session",
    ...responseMetaField(response._meta),
  };
}

function abortTimedOutRequests(error: unknown, lifetime: AbortController): void {
  if (error instanceof TimeoutError) {
    lifetime.abort(error);
  }
}

function promptRequestAuthority(
  lifetime: AbortController,
  authority?: AcpControlAuthority,
): AcpControlAuthority {
  return {
    signal: authority?.signal
      ? AbortSignal.any([authority.signal, lifetime.signal])
      : lifetime.signal,
    assertActive: () => assertControlAuthority(authority),
  };
}

export async function runPromptTurn(params: {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation: SessionConversation;
  promptMessageId?: string;
  onPromptRequestWritten?: () => Promise<void> | void;
  onPromptStarted?: () => Promise<void> | void;
  onElicitation?: AcpElicitationHandler;
  onPermissionRequest?: AcpPermissionHandler;
  authority?: AcpControlAuthority;
}): Promise<{
  stopReason: RunPromptResult["stopReason"];
  source: "rpc" | "session";
  _meta?: Record<string, unknown> | null;
}> {
  let settledResponse: PromptResponse | undefined;
  const lifetime = new AbortController();
  try {
    const promptPromise = params.client.prompt(
      params.sessionId,
      params.prompt,
      params.onPromptRequestWritten,
      params.onElicitation,
      params.onPermissionRequest,
      promptRequestAuthority(lifetime, params.authority),
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
    abortTimedOutRequests(error, lifetime);
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

    if (settledResponse) {
      return recoveredSessionResult(settledResponse, params.conversation, params.promptMessageId);
    }

    throw error;
  } finally {
    lifetime.abort();
  }
}
