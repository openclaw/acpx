import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "./contract.js";
import { asOptionalString, asString, asTrimmedString, isRecord } from "./shared.js";

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

function createToolCallEvent(params: {
  payload: Record<string, unknown>;
  tag: AcpSessionUpdateTag;
}): AcpRuntimeEvent {
  const title = asTrimmedString(params.payload.title) || "tool call";
  const status = asTrimmedString(params.payload.status);
  const inputSummary = summarizeToolInput(params.payload.rawInput);
  const toolCallId = asOptionalString(params.payload.toolCallId);
  const summaryText = status ? `${title} (${status})` : title;
  return {
    type: "tool_call",
    text: inputSummary ? `${summaryText}: ${inputSummary}` : summaryText,
    tag: params.tag,
    ...(toolCallId ? { toolCallId } : {}),
    ...(status ? { status } : {}),
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
