import { extractSessionUpdateNotification } from "../../../../src/acp-jsonrpc.js";
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
} from "../../../../src/session-conversation-model.js";
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
  let promptText: string | null = null;
  let liveTurn: FlowConversationTrace | null = null;
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
