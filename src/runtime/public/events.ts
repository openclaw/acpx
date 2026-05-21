import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "./contract.js";
import { asOptionalString, asString, asTrimmedString, isRecord } from "./shared.js";

const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;

function safeParseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveStructuredPromptPayload(parsed: Record<string, unknown>): {
  type: string;
  payload: Record<string, unknown>;
  tag?: AcpSessionUpdateTag;
} {
  const method = asTrimmedString(parsed.method);
  if (method === "session/update") {
    const params = parsed.params;
    if (isRecord(params) && isRecord(params.update)) {
      const update = params.update;
      const tag = asOptionalString(update.sessionUpdate) as AcpSessionUpdateTag | undefined;
      return {
        type: tag ?? "",
        payload: update,
        ...(tag ? { tag } : {}),
      };
    }
  }

  const sessionUpdate = asOptionalString(parsed.sessionUpdate) as AcpSessionUpdateTag | undefined;
  if (sessionUpdate) {
    return {
      type: sessionUpdate,
      payload: parsed,
      tag: sessionUpdate,
    };
  }

  const type = asTrimmedString(parsed.type);
  const tag = asOptionalString(parsed.tag) as AcpSessionUpdateTag | undefined;
  return {
    type,
    payload: parsed,
    ...(tag ? { tag } : {}),
  };
}

function resolveStatusTextForTag(params: {
  tag: AcpSessionUpdateTag;
  payload: Record<string, unknown>;
}): string | null {
  const resolver = STATUS_TEXT_RESOLVERS[params.tag];
  return resolver ? resolver(params.payload) : null;
}

type StatusTextResolver = (payload: Record<string, unknown>) => string | null;

const STATUS_TEXT_RESOLVERS: Partial<Record<AcpSessionUpdateTag, StatusTextResolver>> = {
  available_commands_update: availableCommandsStatusText,
  current_mode_update: currentModeStatusText,
  config_option_update: configOptionStatusText,
  session_info_update: sessionInfoStatusText,
  plan: planStatusText,
};

function availableCommandsStatusText(payload: Record<string, unknown>): string {
  const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
  return commands.length > 0
    ? `available commands updated (${commands.length})`
    : "available commands updated";
}

function currentModeStatusText(payload: Record<string, unknown>): string {
  const mode =
    asTrimmedString(payload.currentModeId) ||
    asTrimmedString(payload.modeId) ||
    asTrimmedString(payload.mode);
  return mode ? `mode updated: ${mode}` : "mode updated";
}

function configOptionStatusText(payload: Record<string, unknown>): string {
  const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
  const value =
    asTrimmedString(payload.currentValue) ||
    asTrimmedString(payload.value) ||
    asTrimmedString(payload.optionValue);
  if (id && value) {
    return `config updated: ${id}=${value}`;
  }
  return id ? `config updated: ${id}` : "config updated";
}

function sessionInfoStatusText(payload: Record<string, unknown>): string {
  return asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated";
}

function planStatusText(payload: Record<string, unknown>): string | null {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const first = entries.find((entry) => isRecord(entry));
  const content = asTrimmedString(first?.content);
  return content ? `plan: ${content}` : null;
}

function resolveTextChunk(params: {
  payload: Record<string, unknown>;
  stream: "output" | "thought";
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent | null {
  const contentRaw = params.payload.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== "text") {
      return null;
    }
    const text = asString(contentRaw.text);
    if (text && text.length > 0) {
      return {
        type: "text_delta",
        text,
        stream: params.stream,
        tag: params.tag,
      };
    }
  }
  const text = asString(params.payload.text);
  if (!text || text.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text,
    stream: params.stream,
    tag: params.tag,
  };
}

function createTextDeltaEvent(params: {
  content: string | null | undefined;
  stream: "output" | "thought";
  tag?: AcpSessionUpdateTag;
}): AcpRuntimeEvent | null {
  if (params.content == null || params.content.length === 0) {
    return null;
  }
  return {
    type: "text_delta",
    text: params.content,
    stream: params.stream,
    ...(params.tag ? { tag: params.tag } : {}),
  };
}

function readFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = asOptionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstStringArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const entries = value
      .map((entry) => asOptionalString(entry))
      .filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

function summarizeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) {
    return undefined;
  }
  if (
    typeof rawInput === "string" ||
    typeof rawInput === "number" ||
    typeof rawInput === "boolean"
  ) {
    return String(rawInput);
  }
  if (!isRecord(rawInput)) {
    return undefined;
  }

  const command = readFirstString(rawInput, ["command", "cmd", "program"]);
  const args = readFirstStringArray(rawInput, ["args", "arguments"]);
  if (command) {
    return [command, ...(args ?? [])].join(" ");
  }

  return readFirstString(rawInput, [
    "path",
    "file",
    "filePath",
    "filepath",
    "target",
    "uri",
    "url",
    "query",
    "pattern",
    "text",
    "search",
  ]);
}

function truncateToolSummary(value: string): string {
  if (value.length <= TOOL_OUTPUT_SUMMARY_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS - 1)}…`;
}

function readToolContentText(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    return undefined;
  }
  if (record.type === "content") {
    return readToolContentText(record.content);
  }
  const reader = toolContentTextReader(String(record.type));
  return reader?.(record);
}

type ToolContentTextReader = (record: Record<string, unknown>) => string | undefined;

const TOOL_CONTENT_TEXT_READERS: Record<string, ToolContentTextReader> = {
  text: (record) => asString(record.text),
  audio: (record) => `[audio] ${asOptionalString(record.mimeType) || "audio"}`,
  resource_link: (record) =>
    asOptionalString(record.title) || asOptionalString(record.name) || asOptionalString(record.uri),
  resource: (record) => {
    const resource = isRecord(record.resource) ? record.resource : undefined;
    return asString(resource?.text) || asOptionalString(resource?.uri);
  },
  diff: (record) => `diff ${asOptionalString(record.path) || "file"}`,
  terminal: (record) => {
    const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
    return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
  },
};

function toolContentTextReader(type: string): ToolContentTextReader | undefined {
  return Object.hasOwn(TOOL_CONTENT_TEXT_READERS, type)
    ? TOOL_CONTENT_TEXT_READERS[type]
    : undefined;
}

function summarizeToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const fragments = content
    .map((entry) => readToolContentText(entry)?.trim())
    .filter((entry): entry is string => Boolean(entry));
  if (fragments.length === 0) {
    return undefined;
  }
  return truncateToolSummary([...new Set(fragments)].join("\n"));
}

function summarizeToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput == null) {
    return undefined;
  }
  if (isScalarToolOutput(rawOutput)) {
    return truncateToolSummary(String(rawOutput));
  }
  const record = isRecord(rawOutput) ? rawOutput : undefined;
  if (!record) {
    return undefined;
  }
  return (
    truncateToolSummary(
      readFirstString(record, ["text", "message", "error", "stdout", "stderr", "content"]) ?? "",
    ) || undefined
  );
}

function isScalarToolOutput(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function shouldForwardArray(value: unknown): boolean {
  return Array.isArray(value);
}

function readToolKind(value: unknown): ToolKind | undefined {
  const kind = asOptionalString(value);
  return kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : undefined;
}

const TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "fetch",
  "think",
  "other",
]);

function createToolCallEvent(params: {
  payload: Record<string, unknown>;
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent {
  const title = asTrimmedString(params.payload.title) || "tool call";
  const status = asTrimmedString(params.payload.status);
  const inputSummary = summarizeToolInput(params.payload.rawInput);
  const outputSummary =
    summarizeToolContent(params.payload.content) ?? summarizeToolOutput(params.payload.rawOutput);
  const toolCallId = asOptionalString(params.payload.toolCallId);
  const kind = readToolKind(params.payload.kind);
  const summaryText = status ? `${title} (${status})` : title;
  const detailSummary =
    params.tag === "tool_call_update"
      ? (outputSummary ?? inputSummary)
      : (inputSummary ?? outputSummary);
  const event: AcpRuntimeEvent = {
    type: "tool_call",
    text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText,
    tag: params.tag,
    title,
  };
  assignToolCallEventMetadata(event, params.payload, { toolCallId, status, kind });
  return event;
}

function assignToolCallEventMetadata(
  event: AcpRuntimeEvent,
  payload: Record<string, unknown>,
  values: { toolCallId?: string; status?: string; kind?: ToolKind },
): void {
  if (event.type !== "tool_call") {
    return;
  }
  if (values.toolCallId) {
    event.toolCallId = values.toolCallId;
  }
  if (values.status) {
    event.status = values.status;
  }
  if (values.kind) {
    event.kind = values.kind;
  }
  assignForwardedToolPayload(event, payload);
}

function assignForwardedToolPayload(
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
  payload: Record<string, unknown>,
): void {
  if (shouldForwardArray(payload.locations)) {
    event.locations = payload.locations as ToolCallLocation[];
  }
  if (Object.prototype.hasOwnProperty.call(payload, "rawInput")) {
    event.rawInput = payload.rawInput;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "rawOutput")) {
    event.rawOutput = payload.rawOutput;
  }
  if (shouldForwardArray(payload.content)) {
    event.content = payload.content as ToolCallContent[];
  }
}

export function parsePromptEventLine(line: string): AcpRuntimeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = safeParseJsonObject(trimmed);
  if (!parsed) {
    return {
      type: "status",
      text: trimmed,
    };
  }

  const structured = resolveStructuredPromptPayload(parsed);
  const type = structured.type;
  const payload = structured.payload;
  const tag = structured.tag;
  const parser = promptEventParser(type);
  return parser ? parser(payload, tag) : null;
}

type PromptEventParser = (
  payload: Record<string, unknown>,
  tag: AcpSessionUpdateTag | undefined,
) => AcpRuntimeEvent | null;

const PROMPT_EVENT_PARSERS: Record<string, PromptEventParser> = {
  text: (payload, tag) =>
    createTextDeltaEvent({ content: asString(payload.content), stream: "output", tag }),
  thought: (payload, tag) =>
    createTextDeltaEvent({ content: asString(payload.content), stream: "thought", tag }),
  tool_call: (payload, tag) => createToolCallEvent({ payload, tag: tag ?? "tool_call" }),
  tool_call_update: (payload, tag) =>
    createToolCallEvent({ payload, tag: tag ?? "tool_call_update" }),
  agent_message_chunk: (payload) =>
    resolveTextChunk({ payload, stream: "output", tag: "agent_message_chunk" }),
  agent_thought_chunk: (payload) =>
    resolveTextChunk({ payload, stream: "thought", tag: "agent_thought_chunk" }),
  usage_update: usageUpdateEvent,
  available_commands_update: (payload) => statusUpdateEvent("available_commands_update", payload),
  current_mode_update: (payload) => statusUpdateEvent("current_mode_update", payload),
  config_option_update: (payload) => statusUpdateEvent("config_option_update", payload),
  session_info_update: (payload) => statusUpdateEvent("session_info_update", payload),
  plan: (payload) => statusUpdateEvent("plan", payload),
  client_operation: clientOperationEvent,
  update: updateStatusEvent,
  done: () => null,
  error: () => null,
};

function promptEventParser(type: string): PromptEventParser | undefined {
  return Object.hasOwn(PROMPT_EVENT_PARSERS, type) ? PROMPT_EVENT_PARSERS[type] : undefined;
}

function usageUpdateEvent(payload: Record<string, unknown>): AcpRuntimeEvent {
  const used = asOptionalFiniteNumber(payload.used);
  const size = asOptionalFiniteNumber(payload.size);
  const text = used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated";
  return {
    type: "status",
    text,
    tag: "usage_update",
    ...(used != null ? { used } : {}),
    ...(size != null ? { size } : {}),
  };
}

function statusUpdateEvent(
  tag: AcpSessionUpdateTag,
  payload: Record<string, unknown>,
): AcpRuntimeEvent | null {
  const text = resolveStatusTextForTag({ tag, payload });
  if (!text) {
    return null;
  }
  return { type: "status", text, tag };
}

function clientOperationEvent(
  payload: Record<string, unknown>,
  tag: AcpSessionUpdateTag | undefined,
): AcpRuntimeEvent | null {
  const method = asTrimmedString(payload.method) || "operation";
  const status = asTrimmedString(payload.status);
  const summary = asTrimmedString(payload.summary);
  const text = [method, status, summary].filter(Boolean).join(" ");
  return text ? { type: "status", text, ...(tag ? { tag } : {}) } : null;
}

function updateStatusEvent(
  payload: Record<string, unknown>,
  tag: AcpSessionUpdateTag | undefined,
): AcpRuntimeEvent | null {
  const update = asTrimmedString(payload.update);
  return update ? { type: "status", text: update, ...(tag ? { tag } : {}) } : null;
}
