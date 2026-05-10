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
  const { tag, payload } = params;
  if (tag === "available_commands_update") {
    const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
    return commands.length > 0
      ? `available commands updated (${commands.length})`
      : "available commands updated";
  }
  if (tag === "current_mode_update") {
    const mode =
      asTrimmedString(payload.currentModeId) ||
      asTrimmedString(payload.modeId) ||
      asTrimmedString(payload.mode);
    return mode ? `mode updated: ${mode}` : "mode updated";
  }
  if (tag === "config_option_update") {
    const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
    const value =
      asTrimmedString(payload.currentValue) ||
      asTrimmedString(payload.value) ||
      asTrimmedString(payload.optionValue);
    if (id && value) {
      return `config updated: ${id}=${value}`;
    }
    if (id) {
      return `config updated: ${id}`;
    }
    return "config updated";
  }
  if (tag === "session_info_update") {
    return (
      asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated"
    );
  }
  if (tag === "plan") {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const first = entries.find((entry) => isRecord(entry));
    const content = asTrimmedString(first?.content);
    return content ? `plan: ${content}` : null;
  }
  return null;
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
  if (record.type === "text") {
    return asString(record.text);
  }
  if (record.type === "resource_link") {
    return (
      asOptionalString(record.title) ||
      asOptionalString(record.name) ||
      asOptionalString(record.uri)
    );
  }
  if (record.type === "resource") {
    const resource = isRecord(record.resource) ? record.resource : undefined;
    return asString(resource?.text) || asOptionalString(resource?.uri);
  }
  if (record.type === "diff") {
    const path = asOptionalString(record.path) || "file";
    return `diff ${path}`;
  }
  if (record.type === "terminal") {
    const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
    return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
  }
  return undefined;
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
  if (
    typeof rawOutput === "string" ||
    typeof rawOutput === "number" ||
    typeof rawOutput === "boolean"
  ) {
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

function shouldForwardArray(value: unknown): boolean {
  return Array.isArray(value);
}

function readToolKind(value: unknown): ToolKind | undefined {
  const kind = asOptionalString(value);
  if (
    kind === "read" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    kind === "search" ||
    kind === "execute" ||
    kind === "fetch" ||
    kind === "think" ||
    kind === "other"
  ) {
    return kind;
  }
  return undefined;
}

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
  return {
    type: "tool_call",
    text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText,
    tag: params.tag,
    ...(toolCallId ? { toolCallId } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(shouldForwardArray(params.payload.locations)
      ? { locations: params.payload.locations as ToolCallLocation[] }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params.payload, "rawInput")
      ? { rawInput: params.payload.rawInput }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(params.payload, "rawOutput")
      ? { rawOutput: params.payload.rawOutput }
      : {}),
    ...(shouldForwardArray(params.payload.content)
      ? { content: params.payload.content as ToolCallContent[] }
      : {}),
    title,
  };
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

  switch (type) {
    case "text":
      return createTextDeltaEvent({
        content: asString(payload.content),
        stream: "output",
        tag,
      });
    case "thought":
      return createTextDeltaEvent({
        content: asString(payload.content),
        stream: "thought",
        tag,
      });
    case "tool_call":
      return createToolCallEvent({
        payload,
        tag: tag ?? "tool_call",
      });
    case "tool_call_update":
      return createToolCallEvent({
        payload,
        tag: tag ?? "tool_call_update",
      });
    case "agent_message_chunk":
      return resolveTextChunk({
        payload,
        stream: "output",
        tag: "agent_message_chunk",
      });
    case "agent_thought_chunk":
      return resolveTextChunk({
        payload,
        stream: "thought",
        tag: "agent_thought_chunk",
      });
    case "usage_update": {
      const used = asOptionalFiniteNumber(payload.used);
      const size = asOptionalFiniteNumber(payload.size);
      const text =
        used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated";
      return {
        type: "status",
        text,
        tag: "usage_update",
        ...(used != null ? { used } : {}),
        ...(size != null ? { size } : {}),
      };
    }
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "plan": {
      const text = resolveStatusTextForTag({
        tag: type as AcpSessionUpdateTag,
        payload,
      });
      if (!text) {
        return null;
      }
      return {
        type: "status",
        text,
        tag: type as AcpSessionUpdateTag,
      };
    }
    case "client_operation": {
      const method = asTrimmedString(payload.method) || "operation";
      const status = asTrimmedString(payload.status);
      const summary = asTrimmedString(payload.summary);
      const text = [method, status, summary].filter(Boolean).join(" ");
      if (!text) {
        return null;
      }
      return { type: "status", text, ...(tag ? { tag } : {}) };
    }
    case "update": {
      const update = asTrimmedString(payload.update);
      if (!update) {
        return null;
      }
      return { type: "status", text: update, ...(tag ? { tag } : {}) };
    }
    case "done":
    case "error":
      return null;
    default:
      return null;
  }
}
