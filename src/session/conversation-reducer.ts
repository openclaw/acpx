import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import { textPrompt } from "../prompt-content.js";
import type {
  PromptInput,
  SessionAcpxState,
  SessionConversation,
  SessionAvailableCommand,
  SessionAgentContent,
  SessionAgentMessage,
  SessionMessage,
  SessionTokenUsage,
  SessionUsageCost,
  SessionToolResult,
  SessionToolResultContent,
  SessionToolUse,
  SessionUserContent,
} from "../types.js";
import { applyConfigOptionsModelState } from "./model-state.js";

export type ConversationMutation = {
  messageIndex: number | undefined;
};

type UserMessageId = string | (() => string);

function resolveUserMessageId(value: UserMessageId): string {
  return typeof value === "string" ? value : value();
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

function normalizeAgentName(value: unknown): string | undefined {
  return trimmedString(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAvailableCommand(value: unknown): SessionAvailableCommand | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const name = trimmedString(record.name);
  if (!name) {
    return undefined;
  }
  const description = trimmedString(record.description);
  return {
    name,
    ...(description ? { description } : {}),
    has_input: record.input != null,
  };
}

function extractText(content: ContentBlock): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource":
      return extractResourceText(content);
    case "audio":
      return `[audio] ${content.mimeType}`;
    default:
      return undefined;
  }
}

function extractResourceText(content: Extract<ContentBlock, { type: "resource" }>): string {
  return "text" in content.resource && typeof content.resource.text === "string"
    ? content.resource.text
    : content.resource.uri;
}

function contentToUserContent(content: ContentBlock): SessionUserContent | undefined {
  if (content.type === "text") {
    return {
      Text: content.text,
    };
  }

  if (content.type === "resource_link") {
    const value = content.title ?? content.name ?? content.uri;
    return {
      Mention: {
        uri: content.uri,
        content: value,
      },
    };
  }

  if (content.type === "resource") {
    return resourceToUserContent(content);
  }

  if (content.type === "image") {
    return {
      Image: {
        source: content.data,
        mime_type: content.mimeType,
        size: null,
      },
    };
  }

  if (content.type === "audio") {
    return {
      Audio: {
        source: content.data,
        mime_type: content.mimeType,
      },
    };
  }

  return undefined;
}

function resourceToUserContent(
  content: Extract<ContentBlock, { type: "resource" }>,
): SessionUserContent {
  if ("text" in content.resource && typeof content.resource.text === "string") {
    return {
      Text: content.resource.text,
    };
  }

  return {
    Mention: {
      uri: content.resource.uri,
      content: content.resource.uri,
    },
  };
}

export function isUserMessage(message: SessionMessage): message is {
  User: SessionConversation["messages"][number] extends infer T
    ? T extends { User: infer U }
      ? U
      : never
    : never;
} {
  return typeof message === "object" && message !== null && hasOwn(message, "User");
}

export function isAgentMessage(message: SessionMessage): message is { Agent: SessionAgentMessage } {
  return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}

function isAgentTextContent(content: SessionAgentContent): content is { Text: string } {
  return hasOwn(content, "Text");
}

function isAgentThinkingContent(
  content: SessionAgentContent,
): content is { Thinking: { text: string; signature?: string | null } } {
  return hasOwn(content, "Thinking");
}

function isAgentToolUseContent(
  content: SessionAgentContent,
): content is { ToolUse: SessionToolUse } {
  return hasOwn(content, "ToolUse");
}

function updateConversationTimestamp(conversation: SessionConversation, timestamp: string): void {
  conversation.updated_at = timestamp;
}

function ensureAgentMessage(conversation: SessionConversation): SessionAgentMessage {
  const last = conversation.messages.at(-1);
  if (last && isAgentMessage(last)) {
    return last.Agent;
  }

  const created: SessionAgentMessage = {
    content: [],
    tool_results: {},
  };
  conversation.messages.push({ Agent: created });
  return created;
}

function appendAgentText(agent: SessionAgentMessage, text: string): void {
  const last = agent.content.at(-1);
  if (last && isAgentTextContent(last)) {
    last.Text = `${last.Text}${text}`;
    return;
  }

  const next: SessionAgentContent = {
    Text: text,
  };
  agent.content.push(next);
}

function appendAgentThinking(agent: SessionAgentMessage, text: string): void {
  const last = agent.content.at(-1);
  if (last && isAgentThinkingContent(last)) {
    last.Thinking.text = `${last.Thinking.text}${text}`;
    return;
  }

  const next: SessionAgentContent = {
    Thinking: {
      text,
      signature: null,
    },
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

function toToolResultContent(value: unknown): SessionToolResultContent {
  if (typeof value === "string") {
    return { Text: value };
  }

  if (value != null) {
    try {
      return { Text: JSON.stringify(value) ?? "[Unserializable value]" };
    } catch {
      return { Text: "[Unserializable value]" };
    }
  }

  return { Text: "" };
}

function toRawInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {}) ?? "[Unserializable input]";
  } catch {
    return value == null ? "" : "[Unserializable input]";
  }
}

function ensureToolUseContent(agent: SessionAgentMessage, toolCallId: string): SessionToolUse {
  for (const content of agent.content) {
    if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) {
      return content.ToolUse;
    }
  }

  const created: SessionToolUse = {
    id: toolCallId,
    name: "tool_call",
    raw_input: "{}",
    input: {},
    is_input_complete: false,
    thought_signature: null,
  };
  agent.content.push({ ToolUse: created });
  return created;
}

function upsertToolResult(
  agent: SessionAgentMessage,
  toolCallId: string,
  patch: Partial<SessionToolResult>,
): void {
  const existing = hasOwn(agent.tool_results, toolCallId)
    ? agent.tool_results[toolCallId]
    : undefined;
  const fallback = existingToolResultValues(existing);
  const next: SessionToolResult = {
    tool_use_id: toolCallId,
    tool_name: patch.tool_name ?? fallback.tool_name,
    is_error: patch.is_error ?? fallback.is_error,
    content: patch.content ?? fallback.content,
    output: patch.output ?? fallback.output,
  };
  // Tool IDs are opaque; __proto__ must be a serializable own entry.
  Object.defineProperty(agent.tool_results, toolCallId, {
    value: next,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function existingToolResultValues(existing: SessionToolResult | undefined): SessionToolResult {
  if (existing) {
    return existing;
  }
  return {
    tool_use_id: "",
    tool_name: "tool_call",
    is_error: false,
    content: { Text: "" },
    output: undefined,
  };
}

function applyToolCallUpdate(
  agent: SessionAgentMessage,
  update: ToolCall | ToolCallUpdate,
): boolean {
  const contentCount = agent.content.length;
  const tool = ensureToolUseContent(agent, update.toolCallId);

  applyToolIdentityUpdate(tool, update);
  applyToolInputUpdate(tool, update);
  applyToolStatusUpdate(tool, update);
  applyToolResultUpdate(agent, tool, update);
  return (
    agent.content.length !== contentCount ||
    hasOwn(update, "rawInput") ||
    hasToolResultPatch(update)
  );
}

function applyToolIdentityUpdate(tool: SessionToolUse, update: ToolCall | ToolCallUpdate): void {
  if (hasOwn(update, "title")) {
    tool.name =
      normalizeAgentName((update as { title?: unknown }).title) ?? tool.name ?? "tool_call";
  }

  if (hasOwn(update, "kind")) {
    const kindName = normalizeAgentName((update as { kind?: unknown }).kind);
    if (!tool.name || tool.name === "tool_call") {
      tool.name = kindName ?? tool.name;
    }
  }
}

function applyToolInputUpdate(tool: SessionToolUse, update: ToolCall | ToolCallUpdate): void {
  if (!hasOwn(update, "rawInput")) {
    return;
  }
  const rawInput = deepClone((update as { rawInput?: unknown }).rawInput);
  tool.input = rawInput ?? {};
  tool.raw_input = toRawInput(rawInput);
}

function applyToolStatusUpdate(tool: SessionToolUse, update: ToolCall | ToolCallUpdate): void {
  if (hasOwn(update, "status")) {
    tool.is_input_complete = statusIndicatesComplete((update as { status?: unknown }).status);
  }
}

function applyToolResultUpdate(
  agent: SessionAgentMessage,
  tool: SessionToolUse,
  update: ToolCall | ToolCallUpdate,
): void {
  if (!hasToolResultPatch(update)) {
    return;
  }
  const status = (update as { status?: unknown }).status;
  const output = hasOwn(update, "rawOutput")
    ? deepClone((update as { rawOutput?: unknown }).rawOutput)
    : undefined;

  upsertToolResult(agent, update.toolCallId, {
    tool_name: tool.name,
    is_error: status === undefined ? undefined : statusIndicatesError(status),
    content: output === undefined ? undefined : toToolResultContent(output),
    output,
  });
}

function hasToolResultPatch(update: ToolCall | ToolCallUpdate): boolean {
  return ["rawOutput", "status", "title", "kind"].some((key) => hasOwn(update, key));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberField(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function sourceToTokenUsage(source: unknown): SessionTokenUsage | undefined {
  const usageRecord = asRecord(source);
  if (!usageRecord) {
    return undefined;
  }

  const normalized: SessionTokenUsage = {
    input_tokens: numberField(usageRecord, ["input_tokens", "inputTokens"]),
    output_tokens: numberField(usageRecord, ["output_tokens", "outputTokens"]),
    cache_creation_input_tokens: numberField(usageRecord, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cachedWriteTokens",
    ]),
    cache_read_input_tokens: numberField(usageRecord, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cachedReadTokens",
    ]),
    thought_tokens: numberField(usageRecord, ["thought_tokens", "thoughtTokens"]),
    total_tokens: numberField(usageRecord, ["total_tokens", "totalTokens"]),
  };

  if (!hasTokenUsageValue(normalized)) {
    return undefined;
  }

  return normalized;
}

function usageToTokenUsage(update: UsageUpdate): SessionTokenUsage | undefined {
  const updateRecord = asRecord(update);
  const usageMeta = asRecord(updateRecord?._meta)?.usage;
  const source = asRecord(usageMeta) ?? updateRecord;
  if (!source) {
    return undefined;
  }

  return sourceToTokenUsage(source);
}

function hasTokenUsageValue(usage: SessionTokenUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

function usageCost(update: UsageUpdate): SessionUsageCost | undefined {
  const cost = asRecord(asRecord(update)?.cost);
  if (!cost) {
    return undefined;
  }
  return buildUsageCost(numberField(cost, ["amount"]), stringField(cost.currency));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildUsageCost(
  amount: number | undefined,
  currency: string | undefined,
): SessionUsageCost | undefined {
  const cost: SessionUsageCost = {
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

function lastUserMessageId(conversation: SessionConversation): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message && isUserMessage(message)) {
      return message.User.id;
    }
  }
  return undefined;
}

export function createConversation(timestamp: string): SessionConversation {
  return {
    title: null,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    cumulative_cost: undefined,
    request_token_usage: {},
  };
}

export function cloneConversation(conversation: SessionConversation): SessionConversation {
  return {
    title: conversation.title,
    messages: deepClone(conversation.messages ?? []),
    updated_at: conversation.updated_at,
    cumulative_token_usage: deepClone(conversation.cumulative_token_usage ?? {}),
    cumulative_cost: cloneUsageCost(conversation.cumulative_cost),
    request_token_usage: deepClone(conversation.request_token_usage ?? {}),
  };
}

function cloneUsageCost(cost: SessionUsageCost | undefined): SessionUsageCost | undefined {
  return cost ? { ...cost } : undefined;
}

export function cloneSessionAcpxState(
  state: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    current_mode_id: state.current_mode_id,
    desired_mode_id: state.desired_mode_id,
    desired_config_options: state.desired_config_options
      ? { ...state.desired_config_options }
      : undefined,
    current_model_id: state.current_model_id,
    available_models: state.available_models ? [...state.available_models] : undefined,
    ...(state.available_model_names
      ? { available_model_names: { ...state.available_model_names } }
      : {}),
    model_control: state.model_control,
    available_commands: state.available_commands
      ? state.available_commands.map((command) => ({ ...command }))
      : undefined,
    config_options: state.config_options ? deepClone(state.config_options) : undefined,
    session_options: cloneSessionOptions(state.session_options),
  };
}

function cloneSessionOptions(
  options: SessionAcpxState["session_options"],
): SessionAcpxState["session_options"] {
  if (!options) {
    return undefined;
  }
  return {
    model: options.model,
    allowed_tools: options.allowed_tools ? [...options.allowed_tools] : undefined,
    max_turns: options.max_turns,
    ...(options.system_prompt !== undefined
      ? { system_prompt: cloneSystemPromptOption(options.system_prompt) }
      : {}),
    ...(options.env !== undefined ? { env: { ...options.env } } : {}),
  };
}

function cloneSystemPromptOption(
  option: NonNullable<NonNullable<SessionAcpxState["session_options"]>["system_prompt"]>,
): NonNullable<NonNullable<SessionAcpxState["session_options"]>["system_prompt"]> {
  return typeof option === "string" ? option : { append: option.append };
}

export function reducePromptSubmission(
  conversation: SessionConversation,
  prompt: PromptInput | string,
  timestamp: string,
  messageId: UserMessageId,
): ConversationMutation {
  const normalizedPrompt = typeof prompt === "string" ? textPrompt(prompt) : prompt;
  const userContent = normalizedPrompt
    .map((content) => contentToUserContent(content))
    .filter((content) => content !== undefined);
  if (userContent.length === 0) {
    return { messageIndex: undefined };
  }

  conversation.messages.push({
    User: { id: resolveUserMessageId(messageId), content: userContent },
  });
  updateConversationTimestamp(conversation, timestamp);
  return { messageIndex: conversation.messages.length - 1 };
}

export function reduceSessionUpdate(
  conversation: SessionConversation,
  state: SessionAcpxState | undefined,
  notification: SessionNotification,
  timestamp: string,
  userMessageId: UserMessageId,
): ConversationMutation & { acpx: SessionAcpxState } {
  const acpx = ensureAcpxState(state);
  const messageIndex = applySessionUpdate(conversation, acpx, notification.update, userMessageId);
  updateConversationTimestamp(conversation, timestamp);
  return { acpx, messageIndex };
}

export function reducePromptResponseUsage(
  conversation: SessionConversation,
  usage: unknown,
  promptMessageId: string | undefined,
  timestamp: string,
): boolean {
  const tokenUsage = sourceToTokenUsage(usage);
  if (!tokenUsage) {
    return false;
  }

  applyTokenUsage(conversation, tokenUsage, promptMessageId);
  updateConversationTimestamp(conversation, timestamp);
  return true;
}

function applySessionUpdate(
  conversation: SessionConversation,
  acpx: SessionAcpxState,
  update: SessionUpdate,
  userMessageId: UserMessageId,
): number | undefined {
  const handler = Object.hasOwn(SESSION_UPDATE_HANDLERS, update.sessionUpdate)
    ? SESSION_UPDATE_HANDLERS[update.sessionUpdate]
    : undefined;
  return handler?.(conversation, acpx, update, userMessageId);
}

type SessionUpdateHandler = (
  conversation: SessionConversation,
  acpx: SessionAcpxState,
  update: SessionUpdate,
  userMessageId: UserMessageId,
) => number | undefined;

const SESSION_UPDATE_HANDLERS: Record<string, SessionUpdateHandler> = {
  user_message_chunk: (conversation, _acpx, update, userMessageId) => {
    if (update.sessionUpdate === "user_message_chunk") {
      return appendUserMessageChunk(conversation, update.content, userMessageId);
    }
    return undefined;
  },
  agent_message_chunk: (conversation, _acpx, update) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      return appendAgentMessageChunk(conversation, update.content, appendAgentText);
    }
    return undefined;
  },
  agent_thought_chunk: (conversation, _acpx, update) => {
    if (update.sessionUpdate === "agent_thought_chunk") {
      return appendAgentMessageChunk(conversation, update.content, appendAgentThinking);
    }
    return undefined;
  },
  tool_call: applyToolUpdate,
  tool_call_update: applyToolUpdate,
  usage_update: (conversation, _acpx, update) => {
    if (update.sessionUpdate === "usage_update") {
      applyUsageUpdate(conversation, update);
    }
    return undefined;
  },
  session_info_update: (conversation, _acpx, update) => {
    if (update.sessionUpdate === "session_info_update") {
      applySessionInfoUpdate(conversation, update);
    }
    return undefined;
  },
  available_commands_update: (_conversation, acpx, update) => {
    if (update.sessionUpdate === "available_commands_update") {
      acpx.available_commands = update.availableCommands
        .map((entry) => normalizeAvailableCommand(entry))
        .filter((entry): entry is SessionAvailableCommand => entry !== undefined);
    }
    return undefined;
  },
  current_mode_update: (_conversation, acpx, update) => {
    if (update.sessionUpdate === "current_mode_update") {
      acpx.current_mode_id = update.currentModeId;
    }
    return undefined;
  },
  config_option_update: (_conversation, acpx, update) => {
    if (update.sessionUpdate === "config_option_update") {
      const configOptions = deepClone(update.configOptions);
      applyConfigOptionsModelState(acpx, configOptions);
    }
    return undefined;
  },
};

function applyToolUpdate(
  conversation: SessionConversation,
  _acpx: SessionAcpxState,
  update: SessionUpdate,
): number | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  return applyToolCallUpdate(ensureAgentMessage(conversation), update)
    ? conversation.messages.length - 1
    : undefined;
}

function appendUserMessageChunk(
  conversation: SessionConversation,
  content: ContentBlock,
  messageId: UserMessageId,
): number | undefined {
  const userContent = contentToUserContent(content);
  if (!userContent) {
    return undefined;
  }
  conversation.messages.push({
    User: {
      id: resolveUserMessageId(messageId),
      content: [userContent],
    },
  });
  return conversation.messages.length - 1;
}

function appendAgentMessageChunk(
  conversation: SessionConversation,
  content: ContentBlock,
  append: (agent: SessionAgentMessage, text: string) => void,
): number | undefined {
  const text = extractText(content);
  if (!text) {
    return undefined;
  }
  append(ensureAgentMessage(conversation), text);
  return conversation.messages.length - 1;
}

function applyUsageUpdate(conversation: SessionConversation, update: UsageUpdate): void {
  const usage = usageToTokenUsage(update);
  const cost = usageCost(update);
  if (!usage && !cost) {
    return;
  }
  if (usage) {
    applyTokenUsage(conversation, usage);
  }
  if (cost) {
    conversation.cumulative_cost = cost;
  }
}

function applyTokenUsage(
  conversation: SessionConversation,
  usage: SessionTokenUsage,
  promptMessageId?: string,
): void {
  conversation.cumulative_token_usage = usage;
  const userId = promptMessageId ?? lastUserMessageId(conversation);
  if (userId) {
    // Saved message IDs are opaque keys, including __proto__.
    Object.defineProperty(conversation.request_token_usage, userId, {
      value: usage,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function applySessionInfoUpdate(
  conversation: SessionConversation,
  update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
): void {
  if (hasOwn(update, "title")) {
    conversation.title = update.title ?? null;
  }
  if (hasOwn(update, "updatedAt")) {
    conversation.updated_at = update.updatedAt ?? conversation.updated_at;
  }
}
