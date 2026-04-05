import { extractSessionUpdateNotification } from "../../../../src/acp/jsonrpc.js";
import {
  isPromptInput,
  promptToDisplayText,
  type PromptInput,
} from "../../../../src/prompt-content.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../../../../src/session/conversation-model.js";
import type { AcpJsonRpcMessage } from "../../../../src/types.js";
import type {
  FlowConversationTrace,
  FlowStepRecord,
  SessionRecord,
  ViewerRunLiveState,
} from "../src/types.js";

type LiveSessionReplay = {
  record: SessionRecord;
  promptText: string | null;
  conversation: FlowConversationTrace | null;
};

type PersistedLiveTurn = {
  promptText: string | null;
  conversation: FlowConversationTrace;
};

export function synthesizeLiveRunState(bundle: ViewerRunLiveState): ViewerRunLiveState {
  const next = structuredClone(bundle);
  const liveReplayBySessionId = new Map<string, LiveSessionReplay>();

  for (const session of Object.values(next.sessions)) {
    const replay = replayBundledSession(session.id, session.record, session.events);
    session.record = replay.record;
    liveReplayBySessionId.set(session.id, replay);
  }

  const liveStep = createLiveCurrentStep(next, liveReplayBySessionId);
  if (liveStep) {
    next.steps = [...next.steps, liveStep];
    next.run.steps = next.steps;
    if (next.live) {
      next.live.steps = next.steps;
    }
  }

  return next;
}

function createLiveCurrentStep(
  bundle: ViewerRunLiveState,
  liveReplayBySessionId: Map<string, LiveSessionReplay>,
): FlowStepRecord | null {
  if (
    bundle.run.currentAttemptId == null ||
    bundle.run.currentNode == null ||
    bundle.run.currentNodeType !== "acp"
  ) {
    return null;
  }

  if (bundle.steps.some((step) => step.attemptId === bundle.run.currentAttemptId)) {
    return null;
  }

  const sessionId = resolveCurrentSessionId(bundle);
  const session = sessionId ? (bundle.sessions[sessionId] ?? null) : null;
  const replay = sessionId ? (liveReplayBySessionId.get(sessionId) ?? null) : null;
  const startedAt = bundle.run.currentNodeStartedAt ?? bundle.run.updatedAt;

  return {
    attemptId: bundle.run.currentAttemptId,
    nodeId: bundle.run.currentNode,
    nodeType: bundle.run.currentNodeType,
    outcome: "ok",
    startedAt,
    finishedAt: bundle.run.updatedAt,
    promptText: replay?.promptText ?? null,
    rawText: null,
    output: null,
    session: session?.binding ?? null,
    agent: session
      ? {
          agentName: session.binding.agentName,
          agentCommand: session.binding.agentCommand,
          cwd: session.binding.cwd,
        }
      : null,
    ...(sessionId
      ? {
          trace: {
            sessionId,
            ...(replay?.conversation ? { conversation: replay.conversation } : {}),
          },
        }
      : {}),
  };
}

function resolveCurrentSessionId(bundle: ViewerRunLiveState): string | null {
  const currentAttemptId = bundle.run.currentAttemptId;
  if (!currentAttemptId) {
    return null;
  }

  for (let index = bundle.trace.length - 1; index >= 0; index -= 1) {
    const event = bundle.trace[index];
    if (event?.attemptId !== currentAttemptId) {
      continue;
    }

    if (typeof event.sessionId === "string" && event.sessionId.length > 0) {
      return event.sessionId;
    }

    const payloadSessionId = event.payload?.sessionId;
    if (typeof payloadSessionId === "string" && payloadSessionId.length > 0) {
      return payloadSessionId;
    }
  }

  const sessions = Object.values(bundle.sessions);
  return sessions.length === 1 ? sessions[0]!.id : null;
}

function replayBundledSession(
  sessionId: string,
  baseRecord: SessionRecord,
  events: ViewerRunLiveState["sessions"][string]["events"],
): LiveSessionReplay {
  const conversation = cloneSessionConversation({
    title: baseRecord.title ?? null,
    messages: (Array.isArray(baseRecord.messages) ? baseRecord.messages : []) as never[],
    updated_at:
      baseRecord.updated_at ??
      baseRecord.lastUsedAt ??
      baseRecord.createdAt ??
      new Date().toISOString(),
    cumulative_token_usage: baseRecord.cumulative_token_usage ?? {},
    request_token_usage: baseRecord.request_token_usage ?? {},
  });
  let acpxState = cloneSessionAcpxState(baseRecord.acpx as never);
  const baseLastSeq = typeof baseRecord.lastSeq === "number" ? baseRecord.lastSeq : 0;
  const persistedTurn = inferPersistedLiveTurn(
    sessionId,
    conversation.messages,
    events,
    baseLastSeq,
  );
  let promptText: string | null = persistedTurn?.promptText ?? null;
  let liveTurn: FlowConversationTrace | null = persistedTurn?.conversation ?? null;
  let maxSeq = baseLastSeq;

  for (const event of events) {
    maxSeq = Math.max(maxSeq, event.seq);
    if (event.seq <= baseLastSeq) {
      continue;
    }

    const prompt = extractPromptFromMessage(event.message as AcpJsonRpcMessage);
    if (prompt) {
      const messageStart = conversation.messages.length;
      recordPromptSubmission(conversation, prompt, event.at);
      promptText = promptToDisplayText(prompt);
      liveTurn = {
        sessionId,
        messageStart,
        messageEnd: Math.max(messageStart, conversation.messages.length - 1),
        eventStartSeq: event.seq,
        eventEndSeq: event.seq,
      };
      continue;
    }

    const notification = extractSessionUpdateNotification(event.message as AcpJsonRpcMessage);
    if (!notification) {
      continue;
    }

    if (!liveTurn) {
      liveTurn = {
        sessionId,
        messageStart: conversation.messages.length,
        messageEnd: Math.max(0, conversation.messages.length - 1),
        eventStartSeq: event.seq,
        eventEndSeq: event.seq,
      };
    }

    acpxState = recordSessionUpdate(conversation, acpxState, notification, event.at);
    liveTurn.eventEndSeq = event.seq;
    liveTurn.messageEnd = Math.max(liveTurn.messageStart, conversation.messages.length - 1);
  }

  return {
    record: {
      ...baseRecord,
      lastSeq: maxSeq,
      lastUsedAt: conversation.updated_at,
      title: conversation.title,
      messages: conversation.messages,
      updated_at: conversation.updated_at,
      cumulative_token_usage: conversation.cumulative_token_usage,
      request_token_usage: conversation.request_token_usage,
      acpx: acpxState,
    },
    promptText,
    conversation: liveTurn,
  };
}

function extractPromptFromMessage(message: AcpJsonRpcMessage): PromptInput | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if ((message as { method?: unknown }).method !== "session/prompt") {
    return undefined;
  }

  const params = (message as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const prompt = (params as { prompt?: unknown }).prompt;
  if (!isPromptInput(prompt)) {
    return undefined;
  }

  return prompt;
}

function inferPersistedLiveTurn(
  sessionId: string,
  messages: SessionRecord["messages"],
  events: ViewerRunLiveState["sessions"][string]["events"],
  baseLastSeq: number,
): PersistedLiveTurn | null {
  if (baseLastSeq <= 0 || !Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const normalizedMessages = messages as NonNullable<SessionRecord["messages"]>;

  const messageStart = findLastUserMessageIndex(normalizedMessages);
  if (messageStart == null) {
    return null;
  }

  let promptText = promptTextFromUserMessage(normalizedMessages[messageStart]);
  let eventStartSeq: number | null = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.seq > baseLastSeq) {
      continue;
    }

    const prompt = extractPromptFromMessage(event.message as AcpJsonRpcMessage);
    if (!prompt) {
      continue;
    }

    promptText = promptToDisplayText(prompt);
    eventStartSeq = event.seq;
    break;
  }

  return {
    promptText,
    conversation: {
      sessionId,
      messageStart,
      messageEnd: Math.max(messageStart, normalizedMessages.length - 1),
      eventStartSeq: eventStartSeq ?? baseLastSeq,
      eventEndSeq: baseLastSeq,
    },
  };
}

function findLastUserMessageIndex(messages: NonNullable<SessionRecord["messages"]>): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && "User" in message) {
      return index;
    }
  }
  return null;
}

function promptTextFromUserMessage(message: unknown): string | null {
  if (!message || typeof message !== "object" || !("User" in message)) {
    return null;
  }

  const userMessage = message as {
    User?: {
      content?: unknown[];
    };
  };
  const content = Array.isArray(userMessage.User?.content) ? userMessage.User.content : [];
  const text = content
    .map((part: unknown) => {
      if (!part || typeof part !== "object") {
        return null;
      }
      if ("Text" in part && typeof part.Text === "string") {
        return part.Text;
      }
      if ("Mention" in part && part.Mention && typeof part.Mention === "object") {
        const mention = part.Mention as { content?: unknown; uri?: unknown };
        return typeof mention.content === "string"
          ? mention.content
          : typeof mention.uri === "string"
            ? mention.uri
            : null;
      }
      return null;
    })
    .filter((value: string | null): value is string => {
      return typeof value === "string" && value.trim().length > 0;
    })
    .join("\n\n")
    .trim();

  return text.length > 0 ? text : null;
}
