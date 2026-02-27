import type {
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type {
  ClientOperation,
  SessionAcpEvent,
  SessionAcpPlanEntry,
  SessionAcpProjection,
  SessionAcpToolCall,
} from "./types.js";
import { SESSION_ACP_PROJECTION_SCHEMA } from "./types.js";

export const SESSION_ACP_EVENTS_MAX_ENTRIES = 10_000;
export const SESSION_ACP_TOOL_CALLS_MAX_ENTRIES = 512;

function isoNow(): string {
  return new Date().toISOString();
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function trimToMax<T>(entries: T[], max: number): T[] {
  if (entries.length <= max) {
    return entries;
  }
  return entries.slice(entries.length - max);
}

function clonePlanEntries(update: {
  entries: Array<{ content: string; status: string; priority: string }>;
}): SessionAcpPlanEntry[] {
  return update.entries.map((entry) => ({
    content: entry.content,
    status: entry.status as SessionAcpPlanEntry["status"],
    priority: entry.priority as SessionAcpPlanEntry["priority"],
  }));
}

function applyToolCallPatch(
  current: SessionAcpToolCall | undefined,
  update: ToolCall | ToolCallUpdate,
  timestamp: string,
): SessionAcpToolCall {
  const next: SessionAcpToolCall = {
    toolCallId: update.toolCallId,
    title: current?.title,
    status: current?.status,
    kind: current?.kind,
    locations: current?.locations ? deepClone(current.locations) : undefined,
    content: current?.content ? deepClone(current.content) : undefined,
    rawInput: current?.rawInput,
    rawOutput: current?.rawOutput,
    updatedAt: timestamp,
  };

  if ("title" in update) {
    if (update.title == null) {
      next.title = undefined;
    } else {
      next.title = update.title;
    }
  }

  if ("status" in update) {
    if (update.status == null) {
      next.status = undefined;
    } else {
      next.status = update.status;
    }
  }

  if ("kind" in update) {
    if (update.kind == null) {
      next.kind = undefined;
    } else {
      next.kind = update.kind;
    }
  }

  if ("locations" in update) {
    if (update.locations == null) {
      next.locations = undefined;
    } else {
      next.locations = deepClone(update.locations);
    }
  }

  if ("content" in update) {
    if (update.content == null) {
      next.content = undefined;
    } else {
      next.content = deepClone(update.content);
    }
  }

  if (hasOwn(update, "rawInput")) {
    next.rawInput = deepClone(update.rawInput);
  }

  if (hasOwn(update, "rawOutput")) {
    next.rawOutput = deepClone(update.rawOutput);
  }

  return next;
}

function upsertToolCall(
  projection: SessionAcpProjection,
  next: SessionAcpToolCall,
): void {
  const index = projection.toolCalls.findIndex(
    (entry) => entry.toolCallId === next.toolCallId,
  );

  if (index === -1) {
    projection.toolCalls.push(next);
    projection.toolCalls = trimToMax(
      projection.toolCalls,
      SESSION_ACP_TOOL_CALLS_MAX_ENTRIES,
    );
    return;
  }

  projection.toolCalls[index] = next;
}

function addEvent(projection: SessionAcpProjection, event: SessionAcpEvent): void {
  projection.events.push(event);
  projection.events = trimToMax(projection.events, SESSION_ACP_EVENTS_MAX_ENTRIES);
}

function updateUsage(projection: SessionAcpProjection, update: UsageUpdate): void {
  projection.usage = {
    used: update.used,
    size: update.size,
    costAmount:
      update.cost && typeof update.cost.amount === "number"
        ? update.cost.amount
        : undefined,
    costCurrency:
      update.cost && typeof update.cost.currency === "string"
        ? update.cost.currency
        : undefined,
  };
}

function applySessionUpdate(
  projection: SessionAcpProjection,
  update: SessionUpdate,
  timestamp: string,
): void {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const next = applyToolCallPatch(
        projection.toolCalls.find((entry) => entry.toolCallId === update.toolCallId),
        update,
        timestamp,
      );
      upsertToolCall(projection, next);
      break;
    }
    case "tool_call_update": {
      const next = applyToolCallPatch(
        projection.toolCalls.find((entry) => entry.toolCallId === update.toolCallId),
        update,
        timestamp,
      );
      upsertToolCall(projection, next);
      break;
    }
    case "plan": {
      projection.plan = clonePlanEntries(update);
      break;
    }
    case "available_commands_update": {
      projection.availableCommands = update.availableCommands
        .map((command) => command.name)
        .filter((name) => typeof name === "string" && name.trim().length > 0);
      break;
    }
    case "current_mode_update": {
      projection.currentModeId = update.currentModeId;
      break;
    }
    case "config_option_update": {
      projection.configOptions = deepClone(update.configOptions);
      break;
    }
    case "session_info_update": {
      if (hasOwn(update, "title")) {
        projection.sessionTitle = update.title ?? null;
      }
      if (hasOwn(update, "updatedAt")) {
        projection.sessionUpdatedAt = update.updatedAt ?? null;
      }
      break;
    }
    case "usage_update": {
      updateUsage(projection, update);
      break;
    }
    default:
      break;
  }
}

export function createSessionAcpProjection(): SessionAcpProjection {
  return {
    schema: SESSION_ACP_PROJECTION_SCHEMA,
    events: [],
    toolCalls: [],
  };
}

export function cloneSessionAcpProjection(
  projection: SessionAcpProjection | undefined,
): SessionAcpProjection {
  if (!projection) {
    return createSessionAcpProjection();
  }

  return {
    schema: SESSION_ACP_PROJECTION_SCHEMA,
    events: deepClone(projection.events ?? []),
    toolCalls: deepClone(projection.toolCalls ?? []),
    plan: projection.plan ? deepClone(projection.plan) : undefined,
    availableCommands: projection.availableCommands
      ? [...projection.availableCommands]
      : undefined,
    currentModeId: projection.currentModeId,
    configOptions: projection.configOptions
      ? deepClone(projection.configOptions)
      : undefined,
    sessionTitle: projection.sessionTitle,
    sessionUpdatedAt: projection.sessionUpdatedAt,
    usage: projection.usage ? { ...projection.usage } : undefined,
  };
}

export function recordSessionUpdate(
  projection: SessionAcpProjection,
  notification: SessionNotification,
  timestamp = isoNow(),
): void {
  const event: SessionAcpEvent = {
    type: "session_update",
    timestamp,
    update: deepClone(notification.update),
    _meta:
      notification._meta === undefined
        ? undefined
        : notification._meta === null
          ? null
          : deepClone(notification._meta),
  };

  addEvent(projection, event);
  applySessionUpdate(projection, notification.update, timestamp);
}

export function recordClientOperation(
  projection: SessionAcpProjection,
  operation: ClientOperation,
  timestamp = isoNow(),
): void {
  const event: SessionAcpEvent = {
    type: "client_operation",
    timestamp,
    operation: deepClone(operation),
  };
  addEvent(projection, event);
}
