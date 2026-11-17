import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";

type JsonRpcId = string | number | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isAcpMessageObject(value: unknown): value is AnyMessage {
  return asRecord(value) !== null;
}

function hasValidId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isErrorObject(value: unknown): value is { code: number; message: string } {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.code === "number" &&
    Number.isFinite(record.code) &&
    typeof record.message === "string"
  );
}

function hasResultOrError(value: Record<string, unknown>): boolean {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult && hasError) {
    return false;
  }
  if (!hasResult && !hasError) {
    return false;
  }
  if (hasError && !isErrorObject(value.error)) {
    return false;
  }
  return true;
}

function hasMethod(value: Record<string, unknown>): boolean {
  return typeof value.method === "string" && value.method.length > 0;
}

function isJsonRpcRequest(value: Record<string, unknown>): boolean {
  return hasMethod(value) && Object.hasOwn(value, "id") && hasValidId(value.id);
}

function isJsonRpcNotificationRecord(value: Record<string, unknown>): boolean {
  return hasMethod(value) && !Object.hasOwn(value, "id");
}

function isJsonRpcResponse(value: Record<string, unknown>): boolean {
  if (hasMethod(value) || !Object.hasOwn(value, "id") || !hasValidId(value.id)) {
    return false;
  }
  return hasResultOrError(value);
}

export function isAcpJsonRpcMessage(value: unknown): value is AnyMessage {
  const record = asRecord(value);
  if (!record || record.jsonrpc !== "2.0") {
    return false;
  }

  return (
    isJsonRpcNotificationRecord(record) || isJsonRpcRequest(record) || isJsonRpcResponse(record)
  );
}

export function isJsonRpcNotification(message: AnyMessage): boolean {
  return (
    Object.hasOwn(message, "method") &&
    typeof (message as { method?: unknown }).method === "string" &&
    !Object.hasOwn(message, "id")
  );
}

export function isSessionUpdateNotification(message: AnyMessage): boolean {
  return (
    isJsonRpcNotification(message) && (message as { method?: unknown }).method === "session/update"
  );
}

function sessionUpdateHasRequiredFields(update: Record<string, unknown>): boolean {
  const kind = update.sessionUpdate;
  if (typeof kind !== "string") {
    return false;
  }
  if (isMessageChunkKind(kind)) {
    return isChunkContent(update.content);
  }
  if (kind === "plan") {
    return Array.isArray(update.entries) && update.entries.every(isPlanEntry);
  }
  if (kind === "compaction_update") {
    return isCompactionUpdate(update);
  }
  if (kind === "compaction_summary_chunk") {
    return hasCompactionId(update) && isChunkContent(update.content);
  }
  return true;
}

function isMessageChunkKind(kind: string): boolean {
  return (
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "user_message_chunk"
  );
}

function isCompactionUpdate(update: Record<string, unknown>): boolean {
  return (
    hasCompactionId(update) &&
    isNonEmptyString(update.status) &&
    (update.error === undefined || update.error === null || typeof update.error === "string") &&
    (update.summary === undefined || update.summary === null || Array.isArray(update.summary))
  );
}

function hasCompactionId(update: Record<string, unknown>): boolean {
  return isNonEmptyString(update.compactionId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isChunkContent(value: unknown): boolean {
  const content = asRecord(value);
  return (
    content !== null &&
    typeof content.type === "string" &&
    (content.type !== "text" || typeof content.text === "string")
  );
}

function isPlanEntry(value: unknown): boolean {
  const entry = asRecord(value);
  return entry !== null && typeof entry.status === "string" && typeof entry.content === "string";
}

export function extractSessionUpdateNotification(
  message: AnyMessage,
): SessionNotification | undefined {
  if (!isSessionUpdateNotification(message)) {
    return undefined;
  }

  const params = asRecord((message as { params?: unknown }).params);
  if (!params) {
    return undefined;
  }

  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (!sessionId) {
    return undefined;
  }

  const update = asRecord(params.update);
  if (!update || !sessionUpdateHasRequiredFields(update)) {
    return undefined;
  }

  return {
    sessionId,
    update: update as SessionNotification["update"],
  };
}

export function parsePromptStopReason(message: AnyMessage): string | undefined {
  if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) {
    return undefined;
  }
  const record = asRecord((message as { result?: unknown }).result);
  if (!record) {
    return undefined;
  }
  return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

export function parsePermissionNotice(message: AnyMessage): string | undefined {
  if (!Object.hasOwn(message, "id") || !Object.hasOwn(message, "result")) {
    return undefined;
  }
  const result = asRecord((message as { result?: unknown }).result);
  const notice = asRecord(asRecord(result?._meta)?.acpx)?.permissionNotice;
  return typeof notice === "string" ? notice : undefined;
}

export function parseJsonRpcErrorMessage(message: AnyMessage): string | undefined {
  if (!Object.hasOwn(message, "error")) {
    return undefined;
  }
  const errorRecord = asRecord((message as { error?: unknown }).error);
  if (!errorRecord || typeof errorRecord.message !== "string") {
    return undefined;
  }
  return errorRecord.message;
}
