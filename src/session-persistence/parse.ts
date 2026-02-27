import { normalizeRuntimeSessionId } from "../runtime-session-id.js";
import { defaultSessionEventLog } from "../session-event-log.js";
import type {
  SessionAcpxState,
  SessionEventLog,
  SessionRecord,
  SessionConversation,
} from "../types.js";
import { SESSION_RECORD_SCHEMA } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseTokenUsage(
  raw: unknown,
): SessionConversation["cumulative_token_usage"] | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const usage: SessionConversation["cumulative_token_usage"] = {};
  const fields: Array<keyof SessionConversation["cumulative_token_usage"]> = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];

  for (const field of fields) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    usage[field] = value;
  }

  return usage;
}

function parseRequestTokenUsage(
  raw: unknown,
): SessionConversation["request_token_usage"] | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const usage: SessionConversation["request_token_usage"] = {};
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseTokenUsage(value);
    if (parsed == null) {
      return null;
    }
    usage[key] = parsed;
  }

  return usage;
}

function isSessionMessageImage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || typeof record.source !== "string") {
    return false;
  }

  if (record.size === undefined || record.size === null) {
    return true;
  }

  const size = asRecord(record.size);
  return (
    !!size &&
    typeof size.width === "number" &&
    Number.isFinite(size.width) &&
    typeof size.height === "number" &&
    Number.isFinite(size.height)
  );
}

function isUserContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Mention !== undefined) {
    const mention = asRecord(record.Mention);
    return (
      !!mention &&
      typeof mention.uri === "string" &&
      typeof mention.content === "string"
    );
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  return false;
}

function isToolUse(raw: unknown): boolean {
  const record = asRecord(raw);
  return (
    !!record &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.raw_input === "string" &&
    hasOwn(record, "input") &&
    typeof record.is_input_complete === "boolean" &&
    (record.thought_signature === undefined ||
      record.thought_signature === null ||
      typeof record.thought_signature === "string")
  );
}

function isToolResultContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  return false;
}

function isToolResult(raw: unknown): boolean {
  const record = asRecord(raw);
  return (
    !!record &&
    typeof record.tool_use_id === "string" &&
    typeof record.tool_name === "string" &&
    typeof record.is_error === "boolean" &&
    isToolResultContent(record.content)
  );
}

function isAgentContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Thinking !== undefined) {
    const thinking = asRecord(record.Thinking);
    return (
      !!thinking &&
      typeof thinking.text === "string" &&
      (thinking.signature === undefined ||
        thinking.signature === null ||
        typeof thinking.signature === "string")
    );
  }

  if (typeof record.RedactedThinking === "string") {
    return true;
  }

  if (record.ToolUse !== undefined) {
    return isToolUse(record.ToolUse);
  }

  return false;
}

function isUserMessage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || record.User === undefined) {
    return false;
  }

  const user = asRecord(record.User);
  return (
    !!user &&
    typeof user.id === "string" &&
    Array.isArray(user.content) &&
    user.content.every((entry) => isUserContent(entry))
  );
}

function isAgentMessage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || record.Agent === undefined) {
    return false;
  }

  const agent = asRecord(record.Agent);
  if (!agent || !Array.isArray(agent.content) || !agent.content.every(isAgentContent)) {
    return false;
  }

  const toolResults = asRecord(agent.tool_results);
  if (!toolResults) {
    return false;
  }

  return Object.values(toolResults).every(isToolResult);
}

function isConversationMessage(raw: unknown): boolean {
  return raw === "Resume" || isUserMessage(raw) || isAgentMessage(raw);
}

function parseConversationRecord(
  record: Record<string, unknown>,
): SessionConversation | undefined {
  if (
    !Array.isArray(record.messages) ||
    !record.messages.every(isConversationMessage) ||
    typeof record.updated_at !== "string"
  ) {
    return undefined;
  }

  if (
    record.title !== undefined &&
    record.title !== null &&
    typeof record.title !== "string"
  ) {
    return undefined;
  }

  const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
  const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
  if (cumulativeTokenUsage === null || requestTokenUsage === null) {
    return undefined;
  }

  return {
    title:
      record.title === undefined ||
      record.title === null ||
      typeof record.title === "string"
        ? (record.title as string | null | undefined)
        : null,
    messages: record.messages as SessionConversation["messages"],
    updated_at: record.updated_at,
    cumulative_token_usage: cumulativeTokenUsage ?? {},
    request_token_usage: requestTokenUsage ?? {},
  };
}

function parseAcpxState(raw: unknown): SessionAcpxState | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const state: SessionAcpxState = {};

  if (typeof record.current_mode_id === "string") {
    state.current_mode_id = record.current_mode_id;
  }

  if (isStringArray(record.available_commands)) {
    state.available_commands = [...record.available_commands];
  }

  if (Array.isArray(record.config_options)) {
    state.config_options = record.config_options as SessionAcpxState["config_options"];
  }

  return state;
}

function parseEventLog(raw: unknown, sessionId: string): SessionEventLog {
  const record = asRecord(raw);
  if (!record) {
    return defaultSessionEventLog(sessionId);
  }

  if (
    typeof record.active_path !== "string" ||
    typeof record.segment_count !== "number" ||
    !Number.isInteger(record.segment_count) ||
    record.segment_count < 1 ||
    typeof record.max_segment_bytes !== "number" ||
    !Number.isInteger(record.max_segment_bytes) ||
    record.max_segment_bytes < 1 ||
    typeof record.max_segments !== "number" ||
    !Number.isInteger(record.max_segments) ||
    record.max_segments < 1
  ) {
    return defaultSessionEventLog(sessionId);
  }

  return {
    active_path: record.active_path,
    segment_count: record.segment_count,
    max_segment_bytes: record.max_segment_bytes,
    max_segments: record.max_segments,
    last_write_at:
      typeof record.last_write_at === "string" ? record.last_write_at : undefined,
    last_write_error:
      record.last_write_error == null || typeof record.last_write_error === "string"
        ? (record.last_write_error as string | null | undefined)
        : null,
  };
}

function normalizeOptionalName(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalPid(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) <= 0) {
    return null;
  }

  return value as number;
}

function normalizeOptionalBoolean(value: unknown, fallback = false): boolean | null {
  if (value == null) {
    return fallback;
  }
  return typeof value === "boolean" ? value : null;
}

function normalizeOptionalString(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function normalizeOptionalExitCode(value: unknown): number | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (Number.isInteger(value)) {
    return value as number;
  }
  return Symbol("invalid");
}

function normalizeOptionalSignal(
  value: unknown,
): NodeJS.Signals | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value as NodeJS.Signals;
  }
  return Symbol("invalid");
}

export function parseSessionRecord(raw: unknown): SessionRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  if (record.schema !== SESSION_RECORD_SCHEMA) {
    return null;
  }

  const name = normalizeOptionalName(record.name);
  const pid = normalizeOptionalPid(record.pid);
  const closed = normalizeOptionalBoolean(record.closed, false);
  const closedAt = normalizeOptionalString(record.closed_at);
  const agentStartedAt = normalizeOptionalString(record.agent_started_at);
  const lastPromptAt = normalizeOptionalString(record.last_prompt_at);
  const lastAgentExitCode = normalizeOptionalExitCode(record.last_agent_exit_code);
  const lastAgentExitSignal = normalizeOptionalSignal(record.last_agent_exit_signal);
  const lastAgentExitAt = normalizeOptionalString(record.last_agent_exit_at);
  const lastAgentDisconnectReason = normalizeOptionalString(
    record.last_agent_disconnect_reason,
  );

  if (
    typeof record.acpx_record_id !== "string" ||
    typeof record.acp_session_id !== "string" ||
    typeof record.agent_command !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.last_used_at !== "string" ||
    typeof record.last_seq !== "number" ||
    !Number.isInteger(record.last_seq) ||
    record.last_seq < 0 ||
    name === null ||
    pid === null ||
    closed === null ||
    closedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null
  ) {
    return null;
  }

  const conversation = parseConversationRecord(record);
  if (!conversation) {
    return null;
  }

  const eventLog = parseEventLog(record.event_log, record.acpx_record_id);
  const lastRequestId = normalizeOptionalString(record.last_request_id);
  if (lastRequestId === null) {
    return null;
  }

  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: record.acpx_record_id,
    acpSessionId: record.acp_session_id,
    agentSessionId: normalizeRuntimeSessionId(record.agent_session_id),
    agentCommand: record.agent_command,
    cwd: record.cwd,
    name,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    lastSeq: record.last_seq,
    lastRequestId,
    eventLog,
    closed,
    closedAt,
    pid,
    agentStartedAt,
    lastPromptAt,
    lastAgentExitCode,
    lastAgentExitSignal:
      lastAgentExitSignal == null
        ? lastAgentExitSignal
        : (lastAgentExitSignal as NodeJS.Signals),
    lastAgentExitAt,
    lastAgentDisconnectReason,
    protocolVersion:
      typeof record.protocol_version === "number" ? record.protocol_version : undefined,
    agentCapabilities: asRecord(
      record.agent_capabilities,
    ) as SessionRecord["agentCapabilities"],
    title: conversation.title,
    messages: conversation.messages,
    updated_at: conversation.updated_at,
    cumulative_token_usage: conversation.cumulative_token_usage,
    request_token_usage: conversation.request_token_usage,
    acpx: parseAcpxState(record.acpx),
  };
}
