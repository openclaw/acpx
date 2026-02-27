import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ACPX_EVENT_OUTPUT_STREAMS,
  ACPX_EVENT_SCHEMA,
  ACPX_EVENT_STATUS_SNAPSHOT_STATUSES,
  ACPX_EVENT_TURN_MODES,
  ACPX_EVENT_TYPES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type AcpxEvent,
  type AcpxEventDraft,
  type AcpxEventOutputStream,
  type ClientOperation,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "./types.js";

type EventIdentity = {
  sessionId: string;
  acpSessionId?: string;
  agentSessionId?: string;
  requestId?: string;
  seq: number;
  ts?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function truncateInputPreview(message: string, maxChars = 200): string {
  const trimmed = message.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= 3) {
    return trimmed.slice(0, maxChars);
  }
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

export function createAcpxEvent(
  identity: EventIdentity,
  draft: AcpxEventDraft,
): AcpxEvent {
  return {
    schema: ACPX_EVENT_SCHEMA,
    event_id: randomUUID(),
    session_id: identity.sessionId,
    acp_session_id: trimNonEmpty(identity.acpSessionId),
    agent_session_id: trimNonEmpty(identity.agentSessionId),
    request_id: trimNonEmpty(draft.request_id ?? identity.requestId),
    seq: identity.seq,
    ts: identity.ts ?? isoNow(),
    type: draft.type,
    data: draft.data,
  } as AcpxEvent;
}

export function sessionUpdateToEventDrafts(
  notification: SessionNotification,
): AcpxEventDraft[] {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content.type !== "text") {
        return [];
      }
      return [
        {
          type: ACPX_EVENT_TYPES.OUTPUT_DELTA,
          data: {
            stream: "output",
            text: update.content.text,
          },
        },
      ];
    }
    case "agent_thought_chunk": {
      if (update.content.type !== "text") {
        return [];
      }
      return [
        {
          type: ACPX_EVENT_TYPES.OUTPUT_DELTA,
          data: {
            stream: "thought",
            text: update.content.text,
          },
        },
      ];
    }
    case "tool_call":
    case "tool_call_update": {
      return [
        {
          type: ACPX_EVENT_TYPES.TOOL_CALL,
          data: {
            tool_call_id: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
          },
        },
      ];
    }
    case "plan": {
      return [
        {
          type: ACPX_EVENT_TYPES.PLAN,
          data: {
            entries: update.entries.map((entry) => ({
              content: entry.content,
              status: entry.status,
              priority: entry.priority,
            })),
          },
        },
      ];
    }
    default: {
      return [
        {
          type: ACPX_EVENT_TYPES.UPDATE,
          data: {
            update: update.sessionUpdate,
          },
        },
      ];
    }
  }
}

export function clientOperationToEventDraft(
  operation: ClientOperation,
): AcpxEventDraft {
  return {
    type: ACPX_EVENT_TYPES.CLIENT_OPERATION,
    data: {
      method: operation.method,
      status: operation.status,
      summary: operation.summary,
      details: operation.details,
    },
  };
}

export function errorToEventDraft(params: {
  code: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
}): AcpxEventDraft {
  return {
    type: ACPX_EVENT_TYPES.ERROR,
    data: {
      code: params.code,
      detail_code: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp_error: params.acp,
    },
  };
}

function isAcpxEventOutputStream(value: unknown): value is AcpxEventOutputStream {
  return (
    typeof value === "string" &&
    ACPX_EVENT_OUTPUT_STREAMS.includes(value as AcpxEventOutputStream)
  );
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return (
    typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode)
  );
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return (
    typeof value === "string" &&
    OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin)
  );
}

function isAcpError(value: unknown): value is OutputErrorAcpPayload {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.code === "number" &&
    Number.isFinite(record.code) &&
    typeof record.message === "string"
  );
}

export function isAcpxEvent(value: unknown): value is AcpxEvent {
  const event = asRecord(value);
  if (!event) {
    return false;
  }

  if (
    event.schema !== ACPX_EVENT_SCHEMA ||
    typeof event.event_id !== "string" ||
    typeof event.session_id !== "string" ||
    typeof event.seq !== "number" ||
    !Number.isInteger(event.seq) ||
    event.seq < 0 ||
    typeof event.ts !== "string" ||
    typeof event.type !== "string"
  ) {
    return false;
  }

  if (event.request_id !== undefined && typeof event.request_id !== "string") {
    return false;
  }

  if (event.acp_session_id !== undefined && typeof event.acp_session_id !== "string") {
    return false;
  }

  if (
    event.agent_session_id !== undefined &&
    typeof event.agent_session_id !== "string"
  ) {
    return false;
  }

  const data = asRecord(event.data);
  if (!data) {
    return false;
  }

  switch (event.type) {
    case ACPX_EVENT_TYPES.TURN_STARTED:
      return (
        typeof data.mode === "string" &&
        ACPX_EVENT_TURN_MODES.includes(
          data.mode as (typeof ACPX_EVENT_TURN_MODES)[number],
        ) &&
        typeof data.resumed === "boolean"
      );
    case ACPX_EVENT_TYPES.OUTPUT_DELTA:
      return isAcpxEventOutputStream(data.stream) && typeof data.text === "string";
    case ACPX_EVENT_TYPES.TOOL_CALL:
      return true;
    case ACPX_EVENT_TYPES.PLAN:
      return Array.isArray(data.entries);
    case ACPX_EVENT_TYPES.UPDATE:
      return typeof data.update === "string";
    case ACPX_EVENT_TYPES.CLIENT_OPERATION:
      return (
        typeof data.method === "string" &&
        typeof data.status === "string" &&
        typeof data.summary === "string"
      );
    case ACPX_EVENT_TYPES.TURN_DONE:
      return typeof data.stop_reason === "string";
    case ACPX_EVENT_TYPES.ERROR:
      return (
        isOutputErrorCode(data.code) &&
        (data.detail_code === undefined || typeof data.detail_code === "string") &&
        (data.origin === undefined || isOutputErrorOrigin(data.origin)) &&
        typeof data.message === "string" &&
        (data.retryable === undefined || typeof data.retryable === "boolean") &&
        (data.acp_error === undefined || isAcpError(data.acp_error))
      );
    case ACPX_EVENT_TYPES.SESSION_ENSURED:
      return typeof data.created === "boolean";
    case ACPX_EVENT_TYPES.CANCEL_REQUESTED:
      return true;
    case ACPX_EVENT_TYPES.CANCEL_RESULT:
      return typeof data.cancelled === "boolean";
    case ACPX_EVENT_TYPES.MODE_SET:
      return typeof data.mode_id === "string";
    case ACPX_EVENT_TYPES.CONFIG_SET:
      return typeof data.config_id === "string" && typeof data.value === "string";
    case ACPX_EVENT_TYPES.STATUS_SNAPSHOT:
      return (
        typeof data.status === "string" &&
        ACPX_EVENT_STATUS_SNAPSHOT_STATUSES.includes(
          data.status as (typeof ACPX_EVENT_STATUS_SNAPSHOT_STATUSES)[number],
        )
      );
    case ACPX_EVENT_TYPES.SESSION_CLOSED:
      return data.reason === "close";
    default:
      return false;
  }
}
