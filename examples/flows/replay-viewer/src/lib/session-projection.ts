import type { SessionNotification } from "@agentclientprotocol/sdk";
import { extractSessionUpdateNotification } from "../../../../../src/acp/jsonrpc.js";
import { isPromptInput, type PromptInput } from "../../../../../src/prompt-content.js";
import {
  createConversation,
  isUserMessage,
  reducePromptSubmission,
  reduceSessionUpdate,
} from "../../../../../src/session/conversation-reducer.js";
import { trimConversationForRuntime } from "../../../../../src/session/conversation-retention.js";
import type {
  AcpJsonRpcMessage,
  SessionAcpxState,
  SessionConversation,
  SessionMessage,
} from "../../../../../src/types.js";
import type { FlowBundledSessionEvent, FlowConversationTrace, SessionRecord } from "../types.js";

export type ProjectionInterval = Pick<FlowConversationTrace, "eventStartSeq" | "eventEndSeq"> & {
  pending?: true;
};

export type SessionProjection = {
  record: SessionRecord;
  eventMessages: Map<number, number>;
  checkpointMode: "reconstructed" | "opaque" | "unmatched";
  baseLastSeq: number;
  // This context belongs to one projection; it is never part of a saved bundle.
  checkpoint: {
    sessionId: string;
    messageCount: number;
    historicalEventSeqs: ReadonlySet<number>;
  };
};

type CapturedPrompt = { event: FlowBundledSessionEvent; prompt: PromptInput };
type ScheduledPrompt = CapturedPrompt & { interval: ProjectionInterval };
type PromptSchedule = {
  beforeEvent: Map<number, ScheduledPrompt>;
  byPrompt: Map<number, ScheduledPrompt>;
  unownedEvents: Set<number>;
  historicalOwnershipKnown: boolean;
};

const SESSION_METADATA_UPDATES = new Set([
  "session_info_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "plan",
]);

type ReplayState = {
  conversation: SessionConversation;
  acpx: SessionAcpxState | undefined;
  eventMessages: Map<number, number>;
  changed: boolean;
};

type ReplayOperation = {
  eventSeq: number;
  timestamp: string;
  messageId: string;
} & (
  | { type: "prompt"; prompt: PromptInput }
  | { type: "update"; notification: SessionNotification }
);

export function promptInInterval(
  events: readonly FlowBundledSessionEvent[],
  interval: ProjectionInterval,
): CapturedPrompt | undefined {
  if (!validInterval(interval) || interval.eventStartSeq > interval.eventEndSeq) {
    return undefined;
  }
  let captured: CapturedPrompt | undefined;
  let requests = 0;
  for (const event of events) {
    if (!inInterval(event.seq, interval) || !isPromptRequest(event)) {
      continue;
    }
    requests += 1;
    const prompt = extractPrompt(event);
    if (prompt) {
      captured = { event, prompt };
    }
  }
  return requests === 1 ? captured : undefined;
}

export function projectSession(
  sessionId: string,
  baseRecord: SessionRecord,
  events: readonly FlowBundledSessionEvent[],
  intervals: readonly ProjectionInterval[],
  fallbackTimestamp: string,
): SessionProjection {
  const checkpoint = structuredClone(baseRecord);
  const baseLastSeq = validSequence(checkpoint.lastSeq, true) ? checkpoint.lastSeq : 0;
  const orderedEvents = orderedEventPrefix(events);
  const history = orderedEvents.filter((event) => event.seq <= baseLastSeq);
  const schedule = createPromptSchedule(orderedEvents, intervals, baseLastSeq);
  const establishCheckpoint = () =>
    projectCheckpoint(sessionId, checkpoint, history, schedule, baseLastSeq, fallbackTimestamp);
  let { state, checkpointMode } = establishCheckpoint();
  if (
    checkpointMode === "opaque" &&
    events.some((event) => validSequence(event.seq) && event.seq <= baseLastSeq)
  ) {
    checkpointMode = "unmatched";
  }

  let lastSeq = baseLastSeq;
  if (checkpoint.lastSeq !== undefined && !validSequence(checkpoint.lastSeq, true)) {
    checkpointMode = "unmatched";
  } else {
    const acceptedOperations: ReplayOperation[] = [];
    try {
      for (const event of orderedEvents) {
        if (event.seq <= baseLastSeq) {
          continue;
        }
        const operations = eventOperations(
          sessionId,
          event,
          schedule,
          fallbackTimestamp,
          baseLastSeq,
        );
        for (const operation of operations) {
          applyOperation(state, operation);
        }
        acceptedOperations.push(...operations);
        lastSeq = event.seq;
      }
    } catch {
      // Rebuild only on failure: a partially applied event cannot erase verified history.
      state = establishCheckpoint().state;
      for (const operation of acceptedOperations) {
        applyOperation(state, operation);
      }
    }
  }

  return {
    record: projectedRecord(checkpoint, state, lastSeq),
    eventMessages: state.eventMessages,
    checkpointMode,
    baseLastSeq,
    checkpoint: {
      sessionId,
      messageCount: Array.isArray(checkpoint.messages) ? checkpoint.messages.length : 0,
      historicalEventSeqs: new Set(
        (checkpointMode === "unmatched" ? events : history)
          .filter((event) => validSequence(event.seq) && event.seq <= baseLastSeq)
          .map((event) => event.seq),
      ),
    },
  };
}

function projectCheckpoint(
  sessionId: string,
  checkpoint: SessionRecord,
  history: readonly FlowBundledSessionEvent[],
  schedule: PromptSchedule,
  baseLastSeq: number,
  fallbackTimestamp: string,
): { state: ReplayState; checkpointMode: SessionProjection["checkpointMode"] } {
  const state = checkpointState(checkpoint, fallbackTimestamp);
  if (history.length > 0 && completePrefix(history, baseLastSeq)) {
    const reconstructed = reconstructCheckpoint(
      sessionId,
      state,
      history,
      schedule,
      fallbackTimestamp,
    );
    if (reconstructed) {
      return { state: reconstructed, checkpointMode: "reconstructed" };
    }
  }
  return { state, checkpointMode: history.length === 0 ? "opaque" : "unmatched" };
}

export function projectConversationRange(
  projection: SessionProjection,
  original: FlowConversationTrace,
): FlowConversationTrace {
  const empty = { ...original, messageStart: 0, messageEnd: -1 };
  if (
    original.sessionId !== projection.checkpoint.sessionId ||
    !validInterval(original) ||
    original.eventStartSeq > original.eventEndSeq
  ) {
    return empty;
  }
  const historicalEventsPresent = [...projection.checkpoint.historicalEventSeqs].some((seq) =>
    inInterval(seq, original),
  );
  if (projection.checkpointMode === "unmatched" && historicalEventsPresent) {
    return empty;
  }

  let messageStart = Infinity;
  let messageEnd = -1;
  if (
    projection.checkpointMode !== "reconstructed" &&
    !historicalEventsPresent &&
    original.eventEndSeq <= projection.baseLastSeq &&
    validStoredRange(original, projection.checkpoint.messageCount)
  ) {
    messageStart = original.messageStart;
    messageEnd = original.messageEnd;
  }
  for (const [seq, index] of projection.eventMessages) {
    if (inInterval(seq, original)) {
      messageStart = Math.min(messageStart, index);
      messageEnd = Math.max(messageEnd, index);
    }
  }
  return messageEnd < 0 ? empty : { ...original, messageStart, messageEnd };
}

function checkpointState(record: SessionRecord, fallbackTimestamp: string): ReplayState {
  return {
    conversation: {
      title: record.title ?? null,
      messages: structuredClone(
        Array.isArray(record.messages) ? record.messages : [],
      ) as SessionMessage[],
      updated_at: record.updated_at ?? record.lastUsedAt ?? record.createdAt ?? fallbackTimestamp,
      cumulative_token_usage: structuredClone(record.cumulative_token_usage ?? {}),
      cumulative_cost: structuredClone(record.cumulative_cost),
      request_token_usage: structuredClone(record.request_token_usage ?? {}),
    },
    acpx: structuredClone(record.acpx) as SessionAcpxState | undefined,
    eventMessages: new Map(),
    changed: false,
  };
}

function projectedRecord(
  checkpoint: SessionRecord,
  state: ReplayState,
  lastSeq: number,
): SessionRecord {
  const conversation = state.conversation;
  return {
    ...checkpoint,
    lastSeq,
    ...(state.changed ? { lastUsedAt: conversation.updated_at } : {}),
    ...conversation,
    acpx: state.acpx,
  };
}

function createPromptSchedule(
  events: readonly FlowBundledSessionEvent[],
  intervals: readonly ProjectionInterval[],
  baseLastSeq: number,
): PromptSchedule {
  const schedule: PromptSchedule = {
    beforeEvent: new Map(),
    byPrompt: new Map(),
    unownedEvents: new Set(),
    historicalOwnershipKnown: intervals.every(validInterval),
  };
  const ordered = intervals
    .filter((interval) => validInterval(interval) && interval.eventStartSeq <= interval.eventEndSeq)
    .toSorted((left, right) => left.eventStartSeq - right.eventStartSeq);
  let group: ProjectionInterval[] = [];
  let groupEnd = 0;
  const finishGroup = () => {
    if (group.length === 1) {
      scheduleInterval(schedule, group[0], events);
    } else if (group.some((interval) => interval.eventStartSeq <= baseLastSeq)) {
      schedule.historicalOwnershipKnown = false;
    }
  };
  for (const interval of ordered) {
    if (interval.eventStartSeq > groupEnd) {
      finishGroup();
      group = [];
    }
    group.push(interval);
    groupEnd = Math.max(groupEnd, interval.eventEndSeq);
  }
  finishGroup();
  for (const event of events) {
    if (event.seq <= baseLastSeq && isPromptRequest(event) && !schedule.byPrompt.has(event.seq)) {
      schedule.historicalOwnershipKnown = false;
    }
  }
  return schedule;
}

function scheduleInterval(
  schedule: PromptSchedule,
  interval: ProjectionInterval,
  events: readonly FlowBundledSessionEvent[],
): void {
  const captured = promptInInterval(events, interval);
  const firstEvent = events.find((event) => inInterval(event.seq, interval));
  if (!captured || !firstEvent) {
    if (interval.pending) {
      withholdPendingConversation(schedule, interval, events);
    }
    return;
  }
  const scheduled = { ...captured, interval };
  schedule.beforeEvent.set(firstEvent.seq, scheduled);
  schedule.byPrompt.set(captured.event.seq, scheduled);
}

function withholdPendingConversation(
  schedule: PromptSchedule,
  interval: ProjectionInterval,
  events: readonly FlowBundledSessionEvent[],
): void {
  for (const event of events) {
    if (!inInterval(event.seq, interval)) {
      continue;
    }
    if (createsUserBoundary(event)) {
      break;
    }
    schedule.unownedEvents.add(event.seq);
  }
}

function createsUserBoundary(event: FlowBundledSessionEvent): boolean {
  if (event.direction !== "inbound") {
    return false;
  }
  try {
    const notification = extractSessionUpdateNotification(event.message as AcpJsonRpcMessage);
    if (notification?.update.sessionUpdate !== "user_message_chunk") {
      return false;
    }
    const conversation = createConversation(event.at);
    const { messageIndex } = reduceSessionUpdate(
      conversation,
      undefined,
      notification,
      event.at,
      String(event.seq),
    );
    return messageIndex !== undefined;
  } catch {
    return false;
  }
}

function eventOperations(
  sessionId: string,
  event: FlowBundledSessionEvent,
  schedule: PromptSchedule,
  fallbackTimestamp: string,
  checkpointCursor = 0,
): ReplayOperation[] {
  const operations: ReplayOperation[] = [];
  const timestamp = event.at || fallbackTimestamp;
  const scheduled = schedule.beforeEvent.get(event.seq);
  if (scheduled && scheduled.interval.eventStartSeq > checkpointCursor) {
    // Flow inserts its logical User before installing this attempt's capture callbacks.
    operations.push({
      type: "prompt",
      prompt: scheduled.prompt,
      eventSeq: scheduled.event.seq,
      timestamp,
      messageId: `replay:${sessionId}:${scheduled.event.seq}`,
    });
  }
  if (schedule.byPrompt.has(event.seq)) {
    return operations;
  }
  const common = { eventSeq: event.seq, timestamp, messageId: `replay:${sessionId}:${event.seq}` };
  const prompt = extractPrompt(event);
  if (prompt) {
    if (!schedule.unownedEvents.has(event.seq)) {
      operations.push({ ...common, type: "prompt", prompt });
    }
    return operations;
  }
  const notification =
    event.direction === "inbound"
      ? extractSessionUpdateNotification(event.message as AcpJsonRpcMessage)
      : undefined;
  if (
    notification &&
    (!schedule.unownedEvents.has(event.seq) ||
      SESSION_METADATA_UPDATES.has(notification.update.sessionUpdate))
  ) {
    operations.push({ ...common, type: "update", notification });
  }
  return operations;
}

function applyOperation(
  state: ReplayState,
  operation: ReplayOperation,
  retainReceipt = true,
): number | undefined {
  let messageIndex: number | undefined;
  if (operation.type === "prompt") {
    messageIndex = reducePromptSubmission(
      state.conversation,
      operation.prompt,
      operation.timestamp,
      operation.messageId,
    ).messageIndex;
  } else {
    const result = reduceSessionUpdate(
      state.conversation,
      state.acpx,
      operation.notification,
      operation.timestamp,
      operation.messageId,
    );
    state.acpx = result.acpx;
    messageIndex = result.messageIndex;
    state.changed = true;
  }
  if (messageIndex !== undefined) {
    if (retainReceipt) {
      state.eventMessages.set(operation.eventSeq, messageIndex);
    }
    state.changed = true;
  }
  return messageIndex;
}

function reconstructCheckpoint(
  sessionId: string,
  checkpoint: ReplayState,
  history: readonly FlowBundledSessionEvent[],
  schedule: PromptSchedule,
  fallbackTimestamp: string,
): ReplayState | undefined {
  if (!schedule.historicalOwnershipKnown) {
    return undefined;
  }
  const full: ReplayState = {
    conversation: createConversation(fallbackTimestamp),
    acpx: undefined,
    eventMessages: new Map(),
    changed: false,
  };
  const shadow: ReplayState = {
    conversation: createConversation(fallbackTimestamp),
    acpx: undefined,
    eventMessages: new Map(),
    changed: false,
  };
  const links = new WeakMap<object, number>();
  try {
    for (const event of history) {
      for (const operation of eventOperations(sessionId, event, schedule, fallbackTimestamp)) {
        const fullIndex = applyOperation(full, operation);
        const shadowIndex = applyOperation(shadow, operation, false);
        if (fullIndex !== undefined && shadowIndex !== undefined) {
          const message = shadow.conversation.messages[shadowIndex];
          if (typeof message !== "object" || message === null) {
            return undefined;
          }
          const previousLink = links.get(message);
          if (previousLink !== undefined && previousLink !== fullIndex) {
            return undefined;
          }
          links.set(message, fullIndex);
        } else if (fullIndex !== shadowIndex) {
          return undefined;
        }
        trimConversationForRuntime(shadow.conversation);
      }
    }
    const adoptedIds = checkpointIds(full, shadow, checkpoint, links);
    if (!adoptedIds) {
      return undefined;
    }
    for (const message of full.conversation.messages) {
      if (isUserMessage(message)) {
        message.User.id = adoptedIds.get(message.User.id) ?? message.User.id;
      }
    }
    const historicalUsage = Object.fromEntries(
      Object.entries(full.conversation.request_token_usage).map(([id, usage]) => [
        adoptedIds.get(id) ?? id,
        usage,
      ]),
    );
    full.conversation = {
      ...checkpoint.conversation,
      messages: full.conversation.messages,
      request_token_usage: { ...historicalUsage, ...checkpoint.conversation.request_token_usage },
    };
    full.acpx = checkpoint.acpx;
    full.changed = false;
    return full;
  } catch {
    return undefined;
  }
}

function checkpointIds(
  full: ReplayState,
  shadow: ReplayState,
  checkpoint: ReplayState,
  links: WeakMap<object, number>,
): Map<string, string> | undefined {
  const messages = shadow.conversation.messages;
  if (messages.length !== checkpoint.conversation.messages.length) {
    return undefined;
  }
  const ids = new Map<string, string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const saved = checkpoint.conversation.messages[index];
    const fullIndex =
      typeof message === "object" && message !== null ? links.get(message) : undefined;
    if (fullIndex === undefined || !messagesMatch(message, saved)) {
      return undefined;
    }
    const reconstructed = full.conversation.messages[fullIndex];
    if (isUserMessage(message) && isUserMessage(saved) && isUserMessage(reconstructed)) {
      ids.set(reconstructed.User.id, saved.User.id);
    }
  }
  const uniqueIds = new Set<string>();
  for (const message of full.conversation.messages) {
    if (!isUserMessage(message)) {
      continue;
    }
    const id = ids.get(message.User.id) ?? message.User.id;
    if (uniqueIds.has(id)) {
      return undefined;
    }
    uniqueIds.add(id);
  }
  return ids;
}

function messagesMatch(replayed: SessionMessage, saved: SessionMessage): boolean {
  if (!isUserMessage(replayed)) {
    return semanticJson(replayed) === semanticJson(saved);
  }
  const savedUser = asRecord(asRecord(saved)?.User);
  if (!savedUser || typeof savedUser.id !== "string") {
    return false;
  }
  return semanticJson(withoutUserId(replayed)) === semanticJson(withoutUserId(saved));
}

function withoutUserId(message: SessionMessage): unknown {
  const record = asRecord(message);
  const user = asRecord(record?.User);
  return {
    ...record,
    User: Object.fromEntries(Object.entries(user ?? {}).filter(([key]) => key !== "id")),
  };
}

function semanticJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, nested: unknown) => {
    const record = asRecord(nested);
    return record
      ? Object.fromEntries(
          Object.keys(record)
            .toSorted()
            .map((key) => [key, record[key]]),
        )
      : nested;
  });
}

function completePrefix(events: readonly FlowBundledSessionEvent[], lastSeq: number): boolean {
  return events.length === lastSeq && events.every((event, index) => event.seq === index + 1);
}

function orderedEventPrefix(events: readonly FlowBundledSessionEvent[]): FlowBundledSessionEvent[] {
  let previousSeq = 0;
  let length = 0;
  for (const event of events) {
    if (!validSequence(event.seq) || event.seq <= previousSeq) {
      break;
    }
    previousSeq = event.seq;
    length += 1;
  }
  return events.slice(0, length);
}

function validStoredRange(range: FlowConversationTrace, messageCount: number): boolean {
  return (
    Number.isSafeInteger(range.messageStart) &&
    Number.isSafeInteger(range.messageEnd) &&
    range.messageStart >= 0 &&
    range.messageEnd >= range.messageStart &&
    range.messageEnd < messageCount
  );
}

function validInterval(interval: ProjectionInterval): boolean {
  return validSequence(interval.eventStartSeq) && validSequence(interval.eventEndSeq, true);
}

function validSequence(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

function inInterval(seq: number, interval: ProjectionInterval): boolean {
  return seq >= interval.eventStartSeq && seq <= interval.eventEndSeq;
}

function isPromptRequest(event: FlowBundledSessionEvent): boolean {
  return event.direction === "outbound" && asRecord(event.message)?.method === "session/prompt";
}

function extractPrompt(event: FlowBundledSessionEvent): PromptInput | undefined {
  if (!isPromptRequest(event)) {
    return undefined;
  }
  const prompt = asRecord(asRecord(event.message)?.params)?.prompt;
  return isPromptInput(prompt) ? prompt : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
