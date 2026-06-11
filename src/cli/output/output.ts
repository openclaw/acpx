import type {
  AnyMessage,
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  extractSessionUpdateNotification,
  parseJsonRpcErrorMessage,
  parsePromptStopReason,
} from "../../acp/jsonrpc.js";
import type {
  AcpJsonRpcMessage,
  ClientOperation,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputFormatterContext,
  OutputFormat,
  OutputFormatter,
  OutputErrorOrigin,
  PermissionEscalationEvent,
} from "../../types.js";
import { createJsonOutputFormatter } from "./json-formatter.js";
import { isReadLikeTool, SUPPRESSED_READ_OUTPUT } from "./read-suppression.js";

type WritableLike = {
  write(chunk: string): void;
  isTTY?: boolean;
};

type RenderableOutputError = {
  code: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  timestamp?: string;
};

type OutputFormatterOptions = {
  stdout?: WritableLike;
  stderr?: WritableLike;
  jsonContext?: OutputFormatterContext;
  suppressReads?: boolean;
};

type NormalizedToolStatus = ToolCallStatus | "unknown";

type FormatterSection = "assistant" | "thought" | "tool" | "plan" | "client" | "done";

type ToolRenderState = {
  id: string;
  title?: string;
  status?: ToolCallStatus | null;
  kind?: string | null;
  locations?: Array<ToolCallLocation> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<ToolCallContent> | null;
  startedPrinted: boolean;
  finalSignature?: string;
};

const MAX_THOUGHT_CHARS = 900;
const MAX_INLINE_CHARS = 220;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_OUTPUT_LINES = 28;
const MAX_LOCATION_ITEMS = 5;
const OUTPUT_PRIORITY_KEYS = [
  "stdout",
  "stderr",
  "output",
  "content",
  "text",
  "message",
  "result",
  "response",
  "value",
] as const;

function asStatus(status: ToolCallStatus | null | undefined): NormalizedToolStatus {
  return status ?? "unknown";
}

function isFinalStatus(status: NormalizedToolStatus): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

function toStatusLabel(status: NormalizedToolStatus): string {
  switch (status) {
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractJsonRpcMethod(message: AnyMessage): string | undefined {
  return Object.hasOwn(message, "method")
    ? (message as { method?: unknown }).method?.toString()
    : undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function toInline(value: string, maxChars = MAX_INLINE_CHARS): string {
  return truncate(collapseWhitespace(value), maxChars);
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function safeJson(value: unknown, spacing: number): string | undefined {
  const seen = new WeakSet();

  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry === "bigint") {
          return `${entry}n`;
        }
        if (typeof entry === "function") {
          return `[Function ${entry.name || "anonymous"}]`;
        }
        if (typeof entry === "symbol") {
          return entry.toString();
        }
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) {
            return "[Circular]";
          }
          seen.add(entry);
        }
        return entry;
      },
      spacing,
    );
  } catch {
    return undefined;
  }
}

function readFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readFirstFiniteNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function formatMetadataNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));
}

function readFirstStringArray(
  source: Record<string, unknown>,
  keys: string[],
): string[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const entries = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

function formatDisjunction(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function parseAuthMethodIdsFromMessage(message: string): string[] {
  const methods: string[] = [];
  const methodListMatch = message.match(/auth methods \[([^\]]+)\]/iu);
  if (methodListMatch) {
    methods.push(
      ...methodListMatch[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
  }

  const singleMethodMatch = message.match(/auth method ([\w.-]+)/iu);
  if (singleMethodMatch) {
    methods.push(singleMethodMatch[1]);
  }

  return dedupeStrings(methods);
}

function parseAuthMethodIdsFromAcpData(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const methodIds: string[] = [];
  if (typeof record.methodId === "string" && record.methodId.trim().length > 0) {
    methodIds.push(record.methodId.trim());
  }

  if (Array.isArray(record.methods)) {
    for (const entry of record.methods) {
      const id = parseAuthMethodIdEntry(entry);
      if (id) {
        methodIds.push(id);
      }
    }
  }

  return dedupeStrings(methodIds);
}

function parseAuthMethodIdEntry(entry: unknown): string | undefined {
  if (typeof entry === "string" && entry.trim().length > 0) {
    return entry.trim();
  }

  const id = asRecord(entry)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function renderAuthRequiredHint(params: RenderableOutputError): string {
  const methodIds = dedupeStrings([
    ...parseAuthMethodIdsFromAcpData(params.acp?.data),
    ...parseAuthMethodIdsFromMessage(params.message),
  ]);

  if (methodIds.length === 0) {
    return "hint: run `acpx config show` to locate the active config, then add the required credential under `auth` and retry.";
  }

  const configKeys = methodIds.map((methodId) => `\`auth.${methodId}\``);
  return `hint: run \`acpx config show\` to locate the active config, then add ${formatDisjunction(configKeys)} and retry.`;
}

export function getTextErrorRemediationHints(params: RenderableOutputError): string[] {
  const lowerMessage = params.message.toLowerCase();

  if (params.detailCode === "AUTH_REQUIRED") {
    return [renderAuthRequiredHint(params)];
  }

  if (params.code === "TIMEOUT") {
    return [
      "hint: increase `--timeout <seconds>` for long-running prompts, or check whether the agent/provider is stalled.",
    ];
  }

  if (params.code === "NO_SESSION") {
    return noSessionHints(lowerMessage);
  }

  return matchingTextErrorRule(params, lowerMessage)?.hints ?? [];
}

type TextErrorHintRule = {
  matches: (params: RenderableOutputError, lowerMessage: string) => boolean;
  hints: string[];
};

const TEXT_ERROR_HINT_RULES: TextErrorHintRule[] = [
  {
    matches: (_params, lowerMessage) => isUnsupportedSessionLoadError(lowerMessage),
    hints: [
      "hint: this adapter cannot resume saved ACP sessions; create a fresh one with `acpx <agent> sessions new` instead of reusing `--resume-session`.",
    ],
  },
  {
    matches: (_params, lowerMessage) => isSessionLoadError(lowerMessage),
    hints: [
      "hint: rerun with `--verbose` to capture the ACP load failure details.",
      "hint: if you do not need the old backend session, start a fresh one with `acpx <agent> sessions new` and retry.",
    ],
  },
  {
    matches: (params, lowerMessage) => isRateLimitError(params.message, lowerMessage),
    hints: [
      "hint: the provider appears rate-limited; retry later, switch model, or check provider quota/billing.",
    ],
  },
  {
    matches: (_params, lowerMessage) => isModelLookupError(lowerMessage),
    hints: [
      "hint: check the configured model name for this agent, then retry with `--model <model>` or `sessions set-model <model>`.",
    ],
  },
  {
    matches: (_params, lowerMessage) => isSessionConfigMethodError(lowerMessage),
    hints: [
      "hint: rerun with `--verbose` to capture the ACP method/error details before retrying.",
    ],
  },
  {
    matches: isRuntimeAcpProtocolError,
    hints: ["hint: rerun with `--verbose` to capture the underlying ACP error details."],
  },
];

function matchingTextErrorRule(
  params: RenderableOutputError,
  lowerMessage: string,
): TextErrorHintRule | undefined {
  return TEXT_ERROR_HINT_RULES.find((rule) => rule.matches(params, lowerMessage));
}

function noSessionHints(lowerMessage: string): string[] {
  if (lowerMessage.includes("create one:")) {
    return [];
  }
  return [
    "hint: the saved ACP session is missing or stale; start a fresh session with `acpx <agent> sessions new`, then retry.",
  ];
}

function isUnsupportedSessionLoadError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("does not support session/resume") ||
    lowerMessage.includes("does not support session/load")
  );
}

function isSessionLoadError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("failed to resume acp session") ||
    lowerMessage.includes("session/resume") ||
    lowerMessage.includes("session/load")
  );
}

function isRateLimitError(message: string, lowerMessage: string): boolean {
  return (
    /\b429\b/u.test(message) ||
    ["rate limit", "quota exceeded"].some((text) => lowerMessage.includes(text))
  );
}

function isModelLookupError(lowerMessage: string): boolean {
  return ["model not found", "unknown model", "invalid model"].some((text) =>
    lowerMessage.includes(text),
  );
}

function isSessionConfigMethodError(lowerMessage: string): boolean {
  return ["session/set_mode", "session/set_model", "session/set_config_option"].some((text) =>
    lowerMessage.includes(text),
  );
}

function isRuntimeAcpProtocolError(params: RenderableOutputError, lowerMessage: string): boolean {
  return (
    params.origin === "acp" &&
    params.code === "RUNTIME" &&
    (params.acp?.code === -32602 ||
      params.acp?.code === -32603 ||
      lowerMessage.includes("internal error"))
  );
}

function summarizeToolInput(rawInput: unknown): string | undefined {
  if (rawInput == null) {
    return undefined;
  }

  if (isScalarToolInput(rawInput)) {
    return toInline(String(rawInput));
  }

  const record = asRecord(rawInput);
  if (record) {
    return summarizeToolInputRecord(record) ?? summarizeToolInputJson(rawInput);
  }

  return summarizeToolInputJson(rawInput);
}

function isScalarToolInput(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function summarizeToolInputRecord(record: Record<string, unknown>): string | undefined {
  const command = readFirstString(record, ["command", "cmd", "program"]);
  const args = readFirstStringArray(record, ["args", "arguments"]);
  if (command) {
    return toInline([command, ...(args ?? [])].join(" "));
  }

  const location = readFirstString(record, [
    "path",
    "file",
    "filePath",
    "filepath",
    "target",
    "uri",
    "url",
  ]);
  const query = readFirstString(record, ["query", "pattern", "text", "search"]);
  return location || query ? toInline(location ?? query ?? "") : undefined;
}

function summarizeToolInputJson(rawInput: unknown): string | undefined {
  const json = safeJson(rawInput, 0);
  return json ? toInline(json) : undefined;
}

function formatLocations(
  locations: Array<ToolCallLocation> | null | undefined,
): string | undefined {
  if (!locations || locations.length === 0) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const location of locations) {
    const formatted = formatLocation(location);
    if (formatted) {
      unique.add(formatted);
    }
  }

  const items = [...unique];
  if (items.length === 0) {
    return undefined;
  }

  const visible = items.slice(0, MAX_LOCATION_ITEMS);
  const hidden = items.length - visible.length;
  if (hidden <= 0) {
    return visible.join(", ");
  }

  return `${visible.join(", ")}, +${hidden} more`;
}

function formatLocation(location: ToolCallLocation): string | undefined {
  const path = location.path?.trim();
  if (!path) {
    return undefined;
  }

  const line =
    typeof location.line === "number" && Number.isFinite(location.line)
      ? `:${Math.max(1, Math.trunc(location.line))}`
      : "";
  return `${path}${line}`;
}

function summarizeDiff(path: string, oldText: string | null | undefined, newText: string): string {
  const oldLines = oldText ? oldText.split("\n").length : 0;
  const newLines = newText.split("\n").length;
  const delta = newLines - oldLines;

  if (delta === 0) {
    return `diff ${path} (line count unchanged)`;
  }

  const signedDelta = `${delta > 0 ? "+" : ""}${delta}`;
  return `diff ${path} (${signedDelta} lines)`;
}

function textFromContentBlock(content: ContentBlock): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource": {
      return textFromResourceBlock(content);
    }
    case "image":
      return `[image] ${content.mimeType}`;
    case "audio":
      return `[audio] ${content.mimeType}`;
    default:
      return undefined;
  }
}

function textFromResourceBlock(content: Extract<ContentBlock, { type: "resource" }>): string {
  if ("text" in content.resource && typeof content.resource.text === "string") {
    return content.resource.text;
  }
  const uri = content.resource.uri;
  const mimeType = content.resource.mimeType;
  return `[resource] ${uri}${mimeType ? ` (${mimeType})` : ""}`;
}

function summarizeToolContent(
  content: Array<ToolCallContent> | null | undefined,
): string | undefined {
  if (!content || content.length === 0) {
    return undefined;
  }

  const fragments: string[] = [];

  for (const entry of content) {
    const fragment = summarizeToolContentEntry(entry);
    if (fragment) {
      fragments.push(fragment);
    }
  }

  const unique = dedupeStrings(
    fragments.map((fragment) => fragment.trim()).filter((fragment) => fragment.length > 0),
  );
  if (unique.length === 0) {
    return undefined;
  }

  return unique.join("\n\n");
}

function summarizeToolContentEntry(entry: ToolCallContent): string | undefined {
  if (entry.type === "content") {
    const text = textFromContentBlock(entry.content);
    return text && text.trim() ? text.trimEnd() : undefined;
  }
  if (entry.type === "diff") {
    return summarizeDiff(entry.path, entry.oldText, entry.newText);
  }
  if (entry.type === "terminal") {
    return `[terminal] ${entry.terminalId}`;
  }
  return undefined;
}

function extractOutputText(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): string | undefined {
  if (value == null) {
    return undefined;
  }

  const scalar = extractScalarOutputText(value);
  if (scalar !== null) {
    return scalar;
  }

  if (depth >= 4) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return extractOutputTextArray(value, depth, seen);
  }

  return extractOutputTextRecord(value, depth, seen);
}

function extractOutputTextRecord(
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): string | undefined {
  const record = asRecord(value);
  if (!record || seen.has(record)) {
    return undefined;
  }

  seen.add(record);

  return extractPreferredOutputText(record, depth, seen) ?? extractJsonOutputText(record);
}

function extractScalarOutputText(value: unknown): string | undefined | null {
  if (typeof value === "string") {
    const trimmed = value.trimEnd();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function extractOutputTextArray(
  value: unknown[],
  depth: number,
  seen: Set<unknown>,
): string | undefined {
  const parts = value
    .map((entry) => extractOutputText(entry, depth + 1, seen))
    .filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? dedupeStrings(parts).join("\n") : undefined;
}

function extractPreferredOutputText(
  record: Record<string, unknown>,
  depth: number,
  seen: Set<unknown>,
): string | undefined {
  const preferred = OUTPUT_PRIORITY_KEYS.flatMap((key) => {
    if (!(key in record)) {
      return [];
    }
    const extracted = extractOutputText(record[key], depth + 1, seen);
    return extracted ? [extracted] : [];
  });
  const uniquePreferred = dedupeStrings(preferred);
  return uniquePreferred.length > 0 ? uniquePreferred.join("\n") : undefined;
}

function extractJsonOutputText(record: Record<string, unknown>): string | undefined {
  const json = safeJson(record, 2);
  return !json || json === "{}" ? undefined : json;
}

function summarizeToolOutput(
  rawOutput: unknown,
  content: Array<ToolCallContent> | null | undefined,
): string | undefined {
  const outputFromRaw = extractOutputText(rawOutput);
  const outputFromContent = summarizeToolContent(content);

  const fragments = dedupeStrings(
    [outputFromRaw, outputFromContent]
      .map((fragment) => fragment?.trim())
      .filter((fragment): fragment is string => Boolean(fragment)),
  );

  if (fragments.length === 0) {
    return undefined;
  }

  return fragments.join("\n\n");
}

function renderToolOutput(state: ToolRenderState, suppressReads: boolean): string | undefined {
  if (suppressReads && isReadLikeTool(state)) {
    return SUPPRESSED_READ_OUTPUT;
  }

  return summarizeToolOutput(state.rawOutput, state.content);
}

function limitOutputBlock(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  const visible = lines.slice(0, MAX_OUTPUT_LINES);
  let result = visible.join("\n");

  if (lines.length > visible.length) {
    const hidden = lines.length - visible.length;
    result += `\n... (${hidden} more lines)`;
  }

  if (result.length > MAX_OUTPUT_CHARS) {
    result = `${result.slice(0, MAX_OUTPUT_CHARS - 3)}...`;
  }

  return result;
}

class TextOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private readonly useColor: boolean;
  private readonly suppressReads: boolean;
  private readonly toolStates = new Map<string, ToolRenderState>();
  private thoughtBuffer = "";
  private wroteAny = false;
  private atLineStart = true;
  private section: FormatterSection | null = null;

  constructor(stdout: WritableLike, suppressReads: boolean) {
    this.stdout = stdout;
    this.useColor = Boolean(stdout.isTTY);
    this.suppressReads = suppressReads;
  }

  setContext(_context: OutputFormatterContext): void {
    // no-op for text mode
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    const notification = extractSessionUpdateNotification(message);
    if (notification) {
      this.renderSessionUpdate(notification);
      return;
    }

    const method = extractJsonRpcMethod(message);
    if (method && method !== "session/prompt" && method !== "session/cancel") {
      this.onClientOperation({
        method: method as ClientOperation["method"],
        status: "running",
        summary: method,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const stopReason = parsePromptStopReason(message);
    if (stopReason) {
      this.renderDone(stopReason);
      return;
    }

    const errorMessage = parseJsonRpcErrorMessage(message);
    if (errorMessage) {
      this.onError({
        code: "RUNTIME",
        origin: "acp",
        message: errorMessage,
      });
    }
  }

  private renderSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_thought_chunk") {
      this.flushThoughtBuffer();
    }
    this.renderSessionUpdateBody(update);
  }

  private renderSessionUpdateBody(update: SessionNotification["update"]): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.writeAssistantChunk(update.content.text);
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.thoughtBuffer += update.content.text;
        }
        return;
      }
      case "tool_call": {
        this.renderToolUpdate(update);
        return;
      }
      case "tool_call_update": {
        this.renderToolUpdate(update);
        return;
      }
      case "plan": {
        this.renderPlanUpdate(update.entries);
        return;
      }
      default:
        return;
    }
  }

  private renderPlanUpdate(
    entries: Extract<SessionNotification["update"], { sessionUpdate: "plan" }>["entries"],
  ): void {
    this.beginSection("plan");
    this.writeLine(this.bold("[plan]"));
    for (const entry of entries) {
      this.writeLine(`  - [${entry.status}] ${entry.content}`);
    }
  }

  private renderDone(stopReason: string): void {
    this.flushThoughtBuffer();
    this.beginSection("done");
    this.writeLine(this.dim(`[done] ${stopReason}`));
  }

  onError(params: RenderableOutputError): void {
    this.flushThoughtBuffer();
    this.beginSection("done");
    this.writeLine(this.formatAnsi(`[error] ${params.code}: ${params.message}`, "31"));
    for (const hint of getTextErrorRemediationHints(params)) {
      this.writeLine(this.dim(hint));
    }
  }

  onClientOperation(operation: ClientOperation): void {
    this.flushThoughtBuffer();
    this.beginSection("client");

    const normalizedStatus: NormalizedToolStatus =
      operation.status === "completed"
        ? "completed"
        : operation.status === "failed"
          ? "failed"
          : "in_progress";
    const statusText = this.colorStatus(operation.status, normalizedStatus);
    this.writeLine(`${this.bold("[client]")} ${operation.summary} (${statusText})`);
    if (operation.details && operation.details.trim().length > 0) {
      this.writeLine("  details:");
      this.writeLine(indentBlock(operation.details, "    "));
    }
  }

  onPermissionEscalation(event: PermissionEscalationEvent): void {
    this.flushThoughtBuffer();
    this.beginSection("client");
    this.writeLine(`${this.bold("[permission]")} ${event.message}`);
    const details = [
      `sessionId: ${event.sessionId}`,
      `toolCallId: ${event.toolCallId}`,
      event.toolName ? `toolName: ${event.toolName}` : undefined,
      `toolTitle: ${event.toolTitle}`,
      event.toolInput !== undefined
        ? `toolInput: ${summarizeToolInput(event.toolInput) ?? "(structured input)"}`
        : undefined,
      event.toolKind ? `toolKind: ${event.toolKind}` : undefined,
      event.matchedRule ? `matchedRule: ${event.matchedRule}` : undefined,
    ].filter((line): line is string => Boolean(line));
    this.writeLine(indentBlock(details.join("\n"), "  "));
  }

  flush(): void {
    this.flushThoughtBuffer();
    if (!this.atLineStart) {
      this.write("\n");
    }
  }

  private write(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.stdout.write(chunk);
    this.wroteAny = true;
    this.atLineStart = chunk.endsWith("\n");
  }

  private writeLine(line: string): void {
    this.write(`${line}\n`);
  }

  private beginSection(next: Exclude<FormatterSection, "assistant">): void {
    if (!this.atLineStart) {
      this.write("\n");
    }
    if (this.wroteAny) {
      this.write("\n");
    }
    this.section = next;
  }

  private writeAssistantChunk(text: string): void {
    if (!text) {
      return;
    }
    this.section = "assistant";
    this.write(text);
  }

  private flushThoughtBuffer(): void {
    const thought = truncate(normalizeLineEndings(this.thoughtBuffer).trim(), MAX_THOUGHT_CHARS);
    this.thoughtBuffer = "";
    if (!thought) {
      return;
    }

    this.beginSection("thought");
    const [firstLine, ...restLines] = thought.split("\n");
    this.writeLine(this.dim(`[thinking] ${firstLine}`));
    for (const line of restLines) {
      this.writeLine(this.dim(`           ${line}`));
    }
  }

  private renderToolUpdate(update: ToolCall | ToolCallUpdate): void {
    const state = this.getOrCreateToolState(update.toolCallId);
    this.mergeToolState(state, update);

    const status = asStatus(state.status);
    if (isFinalStatus(status)) {
      const signature = this.toolSignature(state);
      if (signature !== state.finalSignature) {
        state.finalSignature = signature;
        this.renderFinalToolState(state, status);
      }
      return;
    }

    if (state.startedPrinted) {
      return;
    }

    state.startedPrinted = true;
    this.renderStartingToolState(state, status);
  }

  private getOrCreateToolState(toolCallId: string): ToolRenderState {
    const existing = this.toolStates.get(toolCallId);
    if (existing) {
      return existing;
    }

    const created: ToolRenderState = {
      id: toolCallId,
      startedPrinted: false,
    };
    this.toolStates.set(toolCallId, created);
    return created;
  }

  private mergeToolState(state: ToolRenderState, update: ToolCall | ToolCallUpdate): void {
    this.mergeToolTitle(state, update.title);
    this.mergeToolPayloadState(state, update);
  }

  private mergeToolTitle(state: ToolRenderState, title: string | null | undefined): void {
    if (typeof title === "string" && title.trim().length > 0) {
      state.title = title;
    }
  }

  private mergeToolPayloadState(state: ToolRenderState, update: ToolCall | ToolCallUpdate): void {
    if (update.status !== undefined) {
      state.status = update.status;
    }
    if (update.kind !== undefined) {
      state.kind = update.kind;
    }
    if (update.locations !== undefined) {
      state.locations = update.locations;
    }
    if (update.rawInput !== undefined) {
      state.rawInput = update.rawInput;
    }
    if (update.rawOutput !== undefined) {
      state.rawOutput = update.rawOutput;
    }
    if (update.content !== undefined) {
      state.content = update.content;
    }
  }

  private toolSignature(state: ToolRenderState): string {
    const signaturePayload = {
      title: state.title,
      status: state.status,
      kind: state.kind,
      input: summarizeToolInput(state.rawInput),
      files: formatLocations(state.locations),
      output: renderToolOutput(state, this.suppressReads),
    };

    return safeJson(signaturePayload, 0) ?? JSON.stringify(signaturePayload);
  }

  private renderStartingToolState(
    state: ToolRenderState,
    status: Exclude<NormalizedToolStatus, "completed" | "failed">,
  ): void {
    this.beginSection("tool");

    const title = state.title ?? state.id;
    const label = status === "pending" ? "pending" : "running";
    const statusText = this.colorStatus(label, status);
    this.writeLine(`${this.bold("[tool]")} ${title} (${statusText})`);

    const input = summarizeToolInput(state.rawInput);
    if (input) {
      this.writeLine(`  input: ${input}`);
    }

    const files = formatLocations(state.locations);
    if (files) {
      this.writeLine(`  files: ${files}`);
    }
  }

  private renderFinalToolState(state: ToolRenderState, status: "completed" | "failed"): void {
    this.beginSection("tool");

    const title = state.title ?? state.id;
    const statusText = this.colorStatus(toStatusLabel(status), status);
    this.writeLine(`${this.bold("[tool]")} ${title} (${statusText})`);

    if (state.kind) {
      this.writeLine(`  kind: ${state.kind}`);
    }

    const input = summarizeToolInput(state.rawInput);
    if (input) {
      this.writeLine(`  input: ${input}`);
    }

    const files = formatLocations(state.locations);
    if (files) {
      this.writeLine(`  files: ${files}`);
    }

    const output = renderToolOutput(state, this.suppressReads);
    if (output) {
      this.writeLine("  output:");
      this.writeLine(indentBlock(limitOutputBlock(output), "    "));
    }
  }

  private formatAnsi(text: string, code: string): string {
    if (!this.useColor) {
      return text;
    }
    return `\u001b[${code}m${text}\u001b[0m`;
  }

  private bold(text: string): string {
    return this.formatAnsi(text, "1");
  }

  private dim(text: string): string {
    return this.formatAnsi(text, "2");
  }

  private colorStatus(text: string, status: NormalizedToolStatus): string {
    if (!this.useColor) {
      return text;
    }

    switch (status) {
      case "completed":
        return this.formatAnsi(text, "32");
      case "failed":
        return this.formatAnsi(text, "31");
      case "pending":
      case "in_progress":
      case "unknown":
      default:
        return this.formatAnsi(text, "33");
    }
  }
}

class QuietOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private readonly stderr: WritableLike;
  private chunks: string[] = [];
  private flushed = false;
  private metadataFlushed = false;

  constructor(stdout: WritableLike, stderr: WritableLike) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  setContext(_context: OutputFormatterContext): void {
    // no-op for quiet mode
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    const update = extractSessionUpdateNotification(message);
    if (
      update?.update.sessionUpdate === "agent_message_chunk" &&
      update.update.content.type === "text"
    ) {
      this.chunks.push(update.update.content.text);
      return;
    }

    if (parsePromptStopReason(message)) {
      this.flushBufferedOutput();
      this.flushMetadata(message);
    }
  }

  onError(_params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    // no-op in quiet mode
  }

  onPermissionEscalation(_event: PermissionEscalationEvent): void {
    // no-op in quiet mode
  }

  flush(): void {
    // no-op for streaming output
  }

  private flushBufferedOutput(): void {
    if (this.flushed) {
      return;
    }

    this.flushed = true;
    const text = this.chunks.join("");
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  private flushMetadata(message: AcpJsonRpcMessage): void {
    if (this.metadataFlushed) {
      return;
    }

    this.metadataFlushed = true;
    const result = asRecord((message as { result?: unknown }).result);
    if (!result) {
      return;
    }

    const usageLine = this.formatUsageLine(asRecord(result.usage));
    if (usageLine) {
      this.stderr.write(`${usageLine}\n`);
    }

    const costLine = this.formatCostLine(result.cost);
    if (costLine) {
      this.stderr.write(`${costLine}\n`);
    }
  }

  private formatUsageLine(usage: Record<string, unknown> | undefined): string | undefined {
    if (!usage) {
      return undefined;
    }

    const parts: string[] = [];
    const fields: Array<[string, string[]]> = [
      ["input", ["inputTokens", "input_tokens"]],
      ["output", ["outputTokens", "output_tokens"]],
      ["cache_read", ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]],
      [
        "cache_write",
        ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
      ],
      ["total", ["totalTokens", "total_tokens"]],
    ];

    for (const [label, keys] of fields) {
      const value = readFirstFiniteNumber(usage, keys);
      if (value !== undefined) {
        parts.push(`${label}=${formatMetadataNumber(value)}`);
      }
    }

    return parts.length > 0 ? `[acpx] tokens: ${parts.join(" ")}` : undefined;
  }

  private formatCostLine(cost: unknown): string | undefined {
    const scalar = this.formatScalarCostLine(cost);
    if (scalar) {
      return scalar;
    }
    const record = asRecord(cost);
    if (!record) {
      return undefined;
    }

    const amount = readFirstFiniteNumber(record, ["amount", "value", "total"]);
    if (amount === undefined) {
      return undefined;
    }

    const currency =
      typeof record.currency === "string" && record.currency.trim()
        ? ` ${record.currency.trim()}`
        : "";
    return `[acpx] cost: ${formatMetadataNumber(amount)}${currency}`;
  }

  private formatScalarCostLine(cost: unknown): string | undefined {
    if (typeof cost === "number" && Number.isFinite(cost)) {
      return `[acpx] cost: ${formatMetadataNumber(cost)}`;
    }

    if (typeof cost === "string" && cost.trim()) {
      return `[acpx] cost: ${cost.trim()}`;
    }

    return undefined;
  }
}

export function createOutputFormatter(
  format: OutputFormat,
  options: OutputFormatterOptions = {},
): OutputFormatter {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const suppressReads = options.suppressReads === true;

  switch (format) {
    case "text":
      return new TextOutputFormatter(stdout, suppressReads);
    case "json":
      return createJsonOutputFormatter(stdout, suppressReads, options.jsonContext);
    case "quiet":
      return new QuietOutputFormatter(stdout, stderr);
    default: {
      const exhaustive: never = format;
      void exhaustive;
      throw new Error("Unsupported output format");
    }
  }
}
