import type {
  SessionAcpxState,
  SessionEventLog,
  SessionRecord,
  SessionConversation,
} from "../../types.js";
import { SESSION_RECORD_SCHEMA } from "../../types.js";
import { defaultSessionEventLog } from "../event-log.js";
import { normalizeRuntimeSessionId } from "../runtime-session-id.js";

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
    if (!isNonNegativeFiniteNumber(value)) {
      return null;
    }
    usage[field] = value;
  }

  return usage;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  return !!size && isFiniteNumber(size.width) && isFiniteNumber(size.height);
}

function isSessionMessageAudio(raw: unknown): boolean {
  const record = asRecord(raw);
  return !!record && typeof record.source === "string" && typeof record.mime_type === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  if (record.Audio !== undefined) {
    return isSessionMessageAudio(record.Audio);
  }

  return false;
}

function isToolUse(raw: unknown): boolean {
  const record = asRecord(raw);
  return (
    !!record &&
    hasStringFields(record, ["id", "name", "raw_input"]) &&
    hasOwn(record, "input") &&
    typeof record.is_input_complete === "boolean" &&
    isOptionalString(record.thought_signature)
  );
}

function hasStringFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
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
    return isThinkingContent(record.Thinking);
  }

  if (typeof record.RedactedThinking === "string") {
    return true;
  }

  if (record.ToolUse !== undefined) {
    return isToolUse(record.ToolUse);
  }

  return false;
}

function isThinkingContent(raw: unknown): boolean {
  const thinking = asRecord(raw);
  return !!thinking && typeof thinking.text === "string" && isOptionalString(thinking.signature);
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

function parseConversationRecord(record: Record<string, unknown>): SessionConversation | undefined {
  if (!hasValidConversationCore(record)) {
    return undefined;
  }

  const title = parseConversationTitle(record.title);
  if (title === INVALID_VALUE) {
    return undefined;
  }

  const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
  const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
  if (cumulativeTokenUsage === null || requestTokenUsage === null) {
    return undefined;
  }

  return {
    title,
    messages: record.messages,
    updated_at: record.updated_at,
    cumulative_token_usage: cumulativeTokenUsage ?? {},
    request_token_usage: requestTokenUsage ?? {},
  };
}

const INVALID_VALUE = Symbol("invalid");

function parseConversationTitle(value: unknown): string | null | undefined | typeof INVALID_VALUE {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  return INVALID_VALUE;
}

function hasValidConversationCore(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  messages: SessionConversation["messages"];
  updated_at: string;
} {
  return (
    Array.isArray(record.messages) &&
    record.messages.every(isConversationMessage) &&
    typeof record.updated_at === "string"
  );
}

function parseAcpxState(raw: unknown): SessionAcpxState | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const state: SessionAcpxState = {};

  assignBooleanTrue(state, "reset_on_next_ensure", record.reset_on_next_ensure);
  assignStringState(state, "current_mode_id", record.current_mode_id);
  assignStringState(state, "desired_mode_id", record.desired_mode_id);

  assignDesiredConfigOptions(state, record.desired_config_options);

  assignStringState(state, "current_model_id", record.current_model_id);

  if (isStringArray(record.available_models)) {
    state.available_models = [...record.available_models];
  }

  if (isStringArray(record.available_commands)) {
    state.available_commands = [...record.available_commands];
  }

  if (Array.isArray(record.config_options)) {
    state.config_options = record.config_options as SessionAcpxState["config_options"];
  }

  assignParsedSessionOptions(state, record.session_options);

  return state;
}

function assignBooleanTrue(
  state: SessionAcpxState,
  key: "reset_on_next_ensure",
  value: unknown,
): void {
  if (value === true) {
    state[key] = true;
  }
}

function assignStringState(
  state: SessionAcpxState,
  key: "current_mode_id" | "desired_mode_id" | "current_model_id",
  value: unknown,
): void {
  if (typeof value === "string") {
    state[key] = value;
  }
}

function assignDesiredConfigOptions(state: SessionAcpxState, raw: unknown): void {
  const desiredConfigOptions = asRecord(raw);
  if (!desiredConfigOptions) {
    return;
  }

  const parsed = Object.fromEntries(
    Object.entries(desiredConfigOptions).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return typeof value === "string";
    }),
  );
  if (Object.keys(parsed).length > 0) {
    state.desired_config_options = parsed;
  }
}

function assignParsedSessionOptions(state: SessionAcpxState, raw: unknown): void {
  const sessionOptions = asRecord(raw);
  if (!sessionOptions) {
    return;
  }

  const parsedSessionOptions: NonNullable<SessionAcpxState["session_options"]> = {};
  assignSessionOptionModel(parsedSessionOptions, sessionOptions.model);
  assignSessionOptionAllowedTools(parsedSessionOptions, sessionOptions.allowed_tools);
  assignSessionOptionMaxTurns(parsedSessionOptions, sessionOptions.max_turns);
  assignSessionOptionSystemPrompt(parsedSessionOptions, sessionOptions.system_prompt);

  if (Object.keys(parsedSessionOptions).length > 0) {
    state.session_options = parsedSessionOptions;
  }
}

function assignSessionOptionModel(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string") {
    options.model = value;
  }
}

function assignSessionOptionAllowedTools(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (isStringArray(value)) {
    options.allowed_tools = [...value];
  }
}

function assignSessionOptionMaxTurns(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    options.max_turns = value;
  }
}

function assignSessionOptionSystemPrompt(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    options.system_prompt = value;
    return;
  }

  const appendRecord = asRecord(value);
  if (appendRecord && typeof appendRecord.append === "string" && appendRecord.append.length > 0) {
    options.system_prompt = { append: appendRecord.append };
  }
}

function parseEventLog(raw: unknown, sessionId: string): SessionEventLog {
  const record = asRecord(raw);
  if (!record || !hasValidEventLogCore(record)) {
    return defaultSessionEventLog(sessionId);
  }

  return {
    active_path: record.active_path,
    segment_count: record.segment_count,
    max_segment_bytes: record.max_segment_bytes,
    max_segments: record.max_segments,
    last_write_at: typeof record.last_write_at === "string" ? record.last_write_at : undefined,
    last_write_error:
      record.last_write_error == null || typeof record.last_write_error === "string"
        ? record.last_write_error
        : null,
  };
}

function hasValidEventLogCore(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
} {
  return (
    typeof record.active_path === "string" &&
    isPositiveInteger(record.segment_count) &&
    isPositiveInteger(record.max_segment_bytes) &&
    isPositiveInteger(record.max_segments)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

function normalizeOptionalSignal(value: unknown): NodeJS.Signals | null | undefined | symbol {
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
  const lastAgentDisconnectReason = normalizeOptionalString(record.last_agent_disconnect_reason);
  const optionals = validSessionOptionals({
    name,
    pid,
    closed,
    closedAt,
    agentStartedAt,
    lastPromptAt,
    lastAgentExitCode,
    lastAgentExitSignal,
    lastAgentExitAt,
    lastAgentDisconnectReason,
  });

  if (!hasValidSessionRecordCore(record) || !optionals) {
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
    name: optionals.name,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    lastSeq: record.last_seq,
    lastRequestId,
    eventLog,
    closed: optionals.closed,
    closedAt: optionals.closedAt,
    pid: optionals.pid,
    agentStartedAt: optionals.agentStartedAt,
    lastPromptAt: optionals.lastPromptAt,
    lastAgentExitCode: optionals.lastAgentExitCode,
    lastAgentExitSignal: optionals.lastAgentExitSignal,
    lastAgentExitAt: optionals.lastAgentExitAt,
    lastAgentDisconnectReason: optionals.lastAgentDisconnectReason,
    protocolVersion:
      typeof record.protocol_version === "number" ? record.protocol_version : undefined,
    agentCapabilities: asRecord(record.agent_capabilities) as SessionRecord["agentCapabilities"],
    title: conversation.title,
    messages: conversation.messages,
    updated_at: conversation.updated_at,
    cumulative_token_usage: conversation.cumulative_token_usage,
    request_token_usage: conversation.request_token_usage,
    acpx: parseAcpxState(record.acpx),
  };
}

function hasValidSessionRecordCore(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  acpx_record_id: string;
  acp_session_id: string;
  agent_command: string;
  cwd: string;
  created_at: string;
  last_used_at: string;
  last_seq: number;
} {
  return (
    hasStringFields(record, [
      "acpx_record_id",
      "acp_session_id",
      "agent_command",
      "cwd",
      "created_at",
      "last_used_at",
    ]) &&
    typeof record.last_seq === "number" &&
    Number.isInteger(record.last_seq) &&
    record.last_seq >= 0
  );
}

type NormalizedSessionOptionals = {
  name: string | undefined | null;
  pid: number | undefined | null;
  closed: boolean | null;
  closedAt: string | undefined | null;
  agentStartedAt: string | undefined | null;
  lastPromptAt: string | undefined | null;
  lastAgentExitCode: number | null | undefined | symbol;
  lastAgentExitSignal: NodeJS.Signals | null | undefined | symbol;
  lastAgentExitAt: string | undefined | null;
  lastAgentDisconnectReason: string | undefined | null;
};

type ValidSessionOptionals = {
  name: string | undefined;
  pid: number | undefined;
  closed: boolean;
  closedAt: string | undefined;
  agentStartedAt: string | undefined;
  lastPromptAt: string | undefined;
  lastAgentExitCode: number | null | undefined;
  lastAgentExitSignal: NodeJS.Signals | null | undefined;
  lastAgentExitAt: string | undefined;
  lastAgentDisconnectReason: string | undefined;
};

function validSessionOptionals(options: NormalizedSessionOptionals): ValidSessionOptionals | null {
  if (hasNullOptionalSessionFields(options) || hasInvalidExitStatus(options)) {
    return null;
  }
  return options as ValidSessionOptionals;
}

function hasNullOptionalSessionFields(options: NormalizedSessionOptionals): boolean {
  return [
    options.name,
    options.pid,
    options.closed,
    options.closedAt,
    options.agentStartedAt,
    options.lastPromptAt,
    options.lastAgentExitAt,
    options.lastAgentDisconnectReason,
  ].some((value) => value === null);
}

function hasInvalidExitStatus(options: NormalizedSessionOptionals): boolean {
  return (
    typeof options.lastAgentExitCode === "symbol" || typeof options.lastAgentExitSignal === "symbol"
  );
}
