import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  ClientOperation,
  PromptInput,
  SessionAcpxState,
  SessionConversation,
} from "../types.js";
import {
  cloneConversation,
  createConversation,
  reducePromptResponseUsage,
  reducePromptSubmission,
  reduceSessionUpdate,
} from "./conversation-reducer.js";
import { trimConversationForRuntime } from "./conversation-retention.js";

export { cloneSessionAcpxState } from "./conversation-reducer.js";
export { trimConversationForRuntime } from "./conversation-retention.js";

function isoNow(): string {
  return new Date().toISOString();
}

export function createSessionConversation(timestamp = isoNow()): SessionConversation {
  return createConversation(timestamp);
}

export function cloneSessionConversation(
  conversation: SessionConversation | undefined,
): SessionConversation {
  return conversation ? cloneConversation(conversation) : createSessionConversation();
}

export function recordPromptSubmission(
  conversation: SessionConversation,
  prompt: PromptInput | string,
  timestamp = isoNow(),
  messageId?: string,
): string | undefined {
  let promptMessageId = messageId;
  const mutation = reducePromptSubmission(
    conversation,
    prompt,
    timestamp,
    () => (promptMessageId ??= randomUUID()),
  );
  if (mutation.messageIndex === undefined) {
    return undefined;
  }
  trimConversationForRuntime(conversation);
  return promptMessageId;
}

export function recordSessionUpdate(
  conversation: SessionConversation,
  state: SessionAcpxState | undefined,
  notification: SessionNotification,
  timestamp = isoNow(),
  userMessageId?: string,
): SessionAcpxState {
  const { acpx } = reduceSessionUpdate(
    conversation,
    state,
    notification,
    timestamp,
    userMessageId ?? randomUUID,
  );
  trimConversationForRuntime(conversation);
  return acpx;
}

export function recordPromptResponseUsage(
  conversation: SessionConversation,
  usage: unknown,
  promptMessageId?: string,
  timestamp = isoNow(),
): boolean {
  if (!reducePromptResponseUsage(conversation, usage, promptMessageId, timestamp)) {
    return false;
  }
  trimConversationForRuntime(conversation);
  return true;
}

export function recordClientOperation(
  conversation: SessionConversation,
  state: SessionAcpxState | undefined,
  _operation: ClientOperation,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = state ?? {};
  conversation.updated_at = timestamp;
  trimConversationForRuntime(conversation);
  return acpx;
}
