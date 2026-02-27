import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type {
  ClientOperation,
  SessionAcpxAuditEvent,
  SessionAcpxState,
  SessionThread,
  SessionThreadAgentContent,
  SessionThreadMessage,
  SessionThreadToolResult,
  SessionThreadUserContent,
} from "./types.js";
import { SESSION_THREAD_VERSION } from "./types.js";

export const SESSION_ACPX_AUDIT_MAX_ENTRIES = 10_000;

export type LegacyHistoryEntry = {
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function trimToMax<T>(entries: T[], max: number): T[] {
  if (entries.length <= max) {
    return entries;
  }
  return entries.slice(entries.length - max);
}

function normalizeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractText(content: ContentBlock): string | undefined {
  if (content.type === "text") {
    return content.text;
  }

  if (content.type === "resource_link") {
    return content.title ?? content.name ?? content.uri;
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return content.resource.text;
    }
    return content.resource.uri;
  }

  return undefined;
}

function contentToUserContent(
  content: ContentBlock,
): SessionThreadUserContent | undefined {
  if (content.type === "text") {
    return {
      type: "text",
      text: content.text,
    };
  }

  if (content.type === "resource_link") {
    const value = content.title ?? content.name ?? content.uri;
    return {
      type: "mention",
      uri: content.uri,
      content: value,
    };
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return {
        type: "text",
        text: content.resource.text,
      };
    }

    return {
      type: "mention",
      uri: content.resource.uri,
      content: content.resource.uri,
    };
  }

  return undefined;
}

function nextUserMessageId(thread: SessionThread): string {
  const count =
    thread.messages.reduce((acc, entry) => acc + (entry.kind === "user" ? 1 : 0), 0) +
    1;
  return `user_${count}`;
}

function updateThreadTimestamp(thread: SessionThread, timestamp: string): void {
  thread.updated_at = timestamp;
}

function ensureAgentMessage(
  thread: SessionThread,
): Extract<SessionThreadMessage, { kind: "agent" }> {
  const last = thread.messages.at(-1);
  if (last && last.kind === "agent") {
    return last;
  }

  const created: Extract<SessionThreadMessage, { kind: "agent" }> = {
    kind: "agent",
    content: [],
  };
  thread.messages.push(created);
  return created;
}

function appendAgentText(
  agent: Extract<SessionThreadMessage, { kind: "agent" }>,
  text: string,
): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && last.type === "text") {
    last.text += text;
    return;
  }

  const next: SessionThreadAgentContent = {
    type: "text",
    text,
  };
  agent.content.push(next);
}

function appendAgentThinking(
  agent: Extract<SessionThreadMessage, { kind: "agent" }>,
  text: string,
): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && last.type === "thinking") {
    last.text += text;
    return;
  }

  const next: SessionThreadAgentContent = {
    type: "thinking",
    text,
    signature: null,
  };
  agent.content.push(next);
}

function statusIndicatesComplete(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized.includes("success") ||
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("cancel")
  );
}

function statusIndicatesError(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error");
}

function toToolResultText(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensureToolUseContent(
  agent: Extract<SessionThreadMessage, { kind: "agent" }>,
  toolCallId: string,
): Extract<SessionThreadAgentContent, { type: "tool_use" }> {
  for (const content of agent.content) {
    if (content.type === "tool_use" && content.id === toolCallId) {
      return content;
    }
  }

  const created: Extract<SessionThreadAgentContent, { type: "tool_use" }> = {
    type: "tool_use",
    id: toolCallId,
    name: "tool_call",
  };
  agent.content.push(created);
  return created;
}

function upsertToolResult(
  agent: Extract<SessionThreadMessage, { kind: "agent" }>,
  toolCallId: string,
  patch: Partial<SessionThreadToolResult>,
): void {
  if (!agent.tool_results) {
    agent.tool_results = {};
  }

  const existing = agent.tool_results[toolCallId];
  const next: SessionThreadToolResult = {
    tool_use_id: toolCallId,
    tool_name: patch.tool_name ?? existing?.tool_name ?? "tool_call",
    is_error: patch.is_error ?? existing?.is_error ?? false,
    content: patch.content ?? existing?.content,
    output: patch.output ?? existing?.output,
  };
  agent.tool_results[toolCallId] = next;
}

function applyToolCallUpdate(
  agent: Extract<SessionThreadMessage, { kind: "agent" }>,
  update: ToolCall | ToolCallUpdate,
): void {
  const tool = ensureToolUseContent(agent, update.toolCallId);

  if (hasOwn(update, "title")) {
    tool.name =
      normalizeAgentName((update as { title?: unknown }).title) ??
      tool.name ??
      "tool_call";
  }

  if (hasOwn(update, "kind")) {
    const kindName = normalizeAgentName((update as { kind?: unknown }).kind);
    if (!tool.name || tool.name === "tool_call") {
      tool.name = kindName ?? tool.name;
    }
  }

  if (hasOwn(update, "rawInput")) {
    tool.raw_input = deepClone((update as { rawInput?: unknown }).rawInput);
    if (tool.raw_input !== undefined) {
      tool.input = deepClone(tool.raw_input);
    }
  }

  if (hasOwn(update, "status")) {
    tool.is_input_complete = statusIndicatesComplete(
      (update as { status?: unknown }).status,
    );
  }

  if (
    hasOwn(update, "rawOutput") ||
    hasOwn(update, "status") ||
    hasOwn(update, "title") ||
    hasOwn(update, "kind")
  ) {
    const status = (update as { status?: unknown }).status;
    const output = hasOwn(update, "rawOutput")
      ? deepClone((update as { rawOutput?: unknown }).rawOutput)
      : undefined;

    upsertToolResult(agent, update.toolCallId, {
      tool_name: tool.name,
      is_error: statusIndicatesError(status),
      content: output === undefined ? undefined : toToolResultText(output),
      output,
    });
  }
}

function usageToObject(update: UsageUpdate): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    used: update.used,
    size: update.size,
  };

  if (update.cost && typeof update.cost.amount === "number") {
    usage.cost_amount = update.cost.amount;
  }
  if (update.cost && typeof update.cost.currency === "string") {
    usage.cost_currency = update.cost.currency;
  }

  return usage;
}

function appendAuditEvent(
  state: SessionAcpxState,
  event: SessionAcpxAuditEvent,
): SessionAcpxState {
  const next = state.audit_events ? [...state.audit_events] : [];
  next.push(event);
  state.audit_events = trimToMax(next, SESSION_ACPX_AUDIT_MAX_ENTRIES);
  return state;
}

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

export function createSessionThread(timestamp = isoNow()): SessionThread {
  return {
    version: SESSION_THREAD_VERSION,
    title: null,
    messages: [],
    updated_at: timestamp,
    detailed_summary: null,
    initial_project_snapshot: null,
    cumulative_token_usage: {},
    request_token_usage: {},
    model: null,
    profile: null,
    imported: false,
    subagent_context: null,
    speed: null,
    thinking_enabled: false,
    thinking_effort: null,
  };
}

export function cloneSessionThread(thread: SessionThread | undefined): SessionThread {
  if (!thread) {
    return createSessionThread();
  }

  return {
    version: SESSION_THREAD_VERSION,
    title: thread.title,
    messages: deepClone(thread.messages ?? []),
    updated_at: thread.updated_at,
    detailed_summary: thread.detailed_summary,
    initial_project_snapshot: deepClone(thread.initial_project_snapshot),
    cumulative_token_usage: deepClone(thread.cumulative_token_usage ?? {}),
    request_token_usage: deepClone(thread.request_token_usage ?? {}),
    model: thread.model,
    profile: thread.profile,
    imported: thread.imported === true,
    subagent_context: deepClone(thread.subagent_context),
    speed: thread.speed,
    thinking_enabled: thread.thinking_enabled === true,
    thinking_effort: thread.thinking_effort,
  };
}

export function cloneSessionAcpxState(
  state: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    current_mode_id: state.current_mode_id,
    available_commands: state.available_commands
      ? [...state.available_commands]
      : undefined,
    config_options: state.config_options ? deepClone(state.config_options) : undefined,
    audit_events: state.audit_events ? deepClone(state.audit_events) : undefined,
  };
}

export function appendLegacyHistory(
  thread: SessionThread,
  entries: LegacyHistoryEntry[],
): void {
  for (const entry of entries) {
    const text = entry.textPreview?.trim();
    if (!text) {
      continue;
    }

    if (entry.role === "user") {
      thread.messages.push({
        kind: "user",
        id: nextUserMessageId(thread),
        content: [{ type: "text", text }],
      });
    } else {
      thread.messages.push({
        kind: "agent",
        content: [{ type: "text", text }],
      });
    }

    updateThreadTimestamp(thread, entry.timestamp || thread.updated_at);
  }
}

export function recordPromptSubmission(
  thread: SessionThread,
  prompt: string,
  timestamp = isoNow(),
): void {
  const text = prompt.trim();
  if (!text) {
    return;
  }

  const message: Extract<SessionThreadMessage, { kind: "user" }> = {
    kind: "user",
    id: nextUserMessageId(thread),
    content: [{ type: "text", text }],
  };
  thread.messages.push(message);
  updateThreadTimestamp(thread, timestamp);
}

export function recordSessionUpdate(
  thread: SessionThread,
  state: SessionAcpxState | undefined,
  notification: SessionNotification,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);
  appendAuditEvent(acpx, {
    type: "session_update",
    timestamp,
    update: deepClone(notification.update),
    _meta:
      notification._meta === undefined
        ? undefined
        : notification._meta === null
          ? null
          : deepClone(notification._meta),
  });

  const update: SessionUpdate = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const userContent = contentToUserContent(update.content);
      if (userContent) {
        thread.messages.push({
          kind: "user",
          id: nextUserMessageId(thread),
          content: [userContent],
        });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(thread);
        appendAgentText(agent, text);
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(thread);
        appendAgentThinking(agent, text);
      }
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      const agent = ensureAgentMessage(thread);
      applyToolCallUpdate(agent, update);
      break;
    }
    case "usage_update": {
      const usage = usageToObject(update);
      thread.request_token_usage = usage;
      thread.cumulative_token_usage = usage;
      break;
    }
    case "session_info_update": {
      if (hasOwn(update, "title")) {
        thread.title = update.title ?? null;
      }
      if (hasOwn(update, "updatedAt")) {
        thread.updated_at = update.updatedAt ?? thread.updated_at;
      }
      break;
    }
    case "available_commands_update": {
      acpx.available_commands = update.availableCommands
        .map((entry) => entry.name)
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0);
      break;
    }
    case "current_mode_update": {
      acpx.current_mode_id = update.currentModeId;
      break;
    }
    case "config_option_update": {
      acpx.config_options = deepClone(update.configOptions);
      break;
    }
    default:
      break;
  }

  updateThreadTimestamp(thread, timestamp);
  return acpx;
}

export function recordClientOperation(
  thread: SessionThread,
  state: SessionAcpxState | undefined,
  operation: ClientOperation,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);
  appendAuditEvent(acpx, {
    type: "client_operation",
    timestamp,
    operation: deepClone(operation),
  });
  updateThreadTimestamp(thread, timestamp);
  return acpx;
}
