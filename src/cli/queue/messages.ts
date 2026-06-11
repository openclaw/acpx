import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { toAcpErrorPayload } from "../../acp/error-shapes.js";
import { isAcpJsonRpcMessage } from "../../acp/jsonrpc.js";
import { isPromptInput, textPrompt } from "../../prompt-content.js";
import {
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type AcpClientOptions,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type PermissionEscalationEvent,
  type PermissionPolicy,
} from "../../types.js";
import type {
  AcpJsonRpcMessage,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
  SessionResumePolicy,
  SessionSendResult,
} from "../../types.js";

type QueueSessionOptions = NonNullable<AcpClientOptions["sessionOptions"]>;

export type QueueSubmitRequest = {
  type: "submit_prompt";
  requestId: string;
  ownerGeneration?: number;
  message: string;
  prompt?: PromptInput;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  promptRetries?: number;
  waitForCompletion: boolean;
  sessionOptions?: QueueSessionOptions;
};

export type QueueCancelRequest = {
  type: "cancel_prompt";
  requestId: string;
  ownerGeneration?: number;
};

export type QueueSetModeRequest = {
  type: "set_mode";
  requestId: string;
  ownerGeneration?: number;
  modeId: string;
  timeoutMs?: number;
};

export type QueueSetModelRequest = {
  type: "set_model";
  requestId: string;
  ownerGeneration?: number;
  modelId: string;
  timeoutMs?: number;
};

export type QueueSetConfigOptionRequest = {
  type: "set_config_option";
  requestId: string;
  ownerGeneration?: number;
  configId: string;
  value: string;
  timeoutMs?: number;
};

export type QueueCloseSessionRequest = {
  type: "close_session";
  requestId: string;
  ownerGeneration?: number;
  timeoutMs?: number;
};

export type QueueRequest =
  | QueueSubmitRequest
  | QueueCancelRequest
  | QueueSetModeRequest
  | QueueSetModelRequest
  | QueueSetConfigOptionRequest
  | QueueCloseSessionRequest;

export type QueueOwnerAcceptedMessage = {
  type: "accepted";
  requestId: string;
  ownerGeneration?: number;
};

export type QueueOwnerEventMessage = {
  type: "event";
  requestId: string;
  ownerGeneration?: number;
  message: AcpJsonRpcMessage;
};

export type QueueOwnerPermissionEscalationMessage = {
  type: "permission_escalation";
  requestId: string;
  ownerGeneration?: number;
  event: PermissionEscalationEvent;
};

export type QueueOwnerResultMessage = {
  type: "result";
  requestId: string;
  ownerGeneration?: number;
  result: SessionSendResult;
};

export type QueueOwnerCancelResultMessage = {
  type: "cancel_result";
  requestId: string;
  ownerGeneration?: number;
  cancelled: boolean;
};

export type QueueOwnerSetModeResultMessage = {
  type: "set_mode_result";
  requestId: string;
  ownerGeneration?: number;
  modeId: string;
};

export type QueueOwnerSetModelResultMessage = {
  type: "set_model_result";
  requestId: string;
  ownerGeneration?: number;
  modelId: string;
  response?: SetSessionConfigOptionResponse;
};

export type QueueOwnerSetConfigOptionResultMessage = {
  type: "set_config_option_result";
  requestId: string;
  ownerGeneration?: number;
  response: SetSessionConfigOptionResponse;
};

export type QueueOwnerCloseSessionResultMessage = {
  type: "close_session_result";
  requestId: string;
  ownerGeneration?: number;
  closed: boolean;
};

export type QueueOwnerErrorMessage = {
  type: "error";
  requestId: string;
  ownerGeneration?: number;
  code?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  outputAlreadyEmitted?: boolean;
};

export type QueueOwnerMessage =
  | QueueOwnerAcceptedMessage
  | QueueOwnerEventMessage
  | QueueOwnerPermissionEscalationMessage
  | QueueOwnerResultMessage
  | QueueOwnerCancelResultMessage
  | QueueOwnerSetModeResultMessage
  | QueueOwnerSetModelResultMessage
  | QueueOwnerSetConfigOptionResultMessage
  | QueueOwnerCloseSessionResultMessage
  | QueueOwnerErrorMessage;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all";
}

function isSessionResumePolicy(value: unknown): value is SessionResumePolicy {
  return value === "allow-new" || value === "same-session-only";
}

function isNonInteractivePermissionPolicy(value: unknown): value is NonInteractivePermissionPolicy {
  return value === "deny" || value === "fail";
}

function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return hasValidPermissionRuleLists(record) && hasValidPermissionDefaultAction(record);
}

function hasValidPermissionRuleLists(record: Record<string, unknown>): boolean {
  const stringListKeys = ["autoApprove", "autoDeny", "escalate"] as const;
  for (const key of stringListKeys) {
    if (!isOptionalStringList(record[key])) {
      return false;
    }
  }
  return true;
}

function isOptionalStringList(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function hasValidPermissionDefaultAction(record: Record<string, unknown>): boolean {
  return (
    record.defaultAction == null ||
    record.defaultAction === "approve" ||
    record.defaultAction === "deny" ||
    record.defaultAction === "escalate"
  );
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function isPermissionEscalationEvent(value: unknown): value is PermissionEscalationEvent {
  const event = asRecord(value);
  return (
    !!event &&
    hasRequiredPermissionEscalationFields(event) &&
    hasOptionalStringFields(event, ["toolName", "toolKind", "matchedRule"])
  );
}

function hasRequiredPermissionEscalationFields(event: Record<string, unknown>): boolean {
  return (
    event.type === "permission_escalation" &&
    typeof event.sessionId === "string" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolTitle === "string" &&
    event.action === "escalate" &&
    typeof event.message === "string" &&
    typeof event.timestamp === "string"
  );
}

function hasOptionalStringFields(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => record[key] == null || typeof record[key] === "string");
}

function parseSessionOptions(value: unknown): QueueSessionOptions | null | undefined {
  if (value == null) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const sessionOptions: QueueSessionOptions = {};
  if (!assignSessionModel(sessionOptions, record.model)) {
    return null;
  }
  if (!assignSessionAllowedTools(sessionOptions, record.allowedTools)) {
    return null;
  }
  if (!assignSessionMaxTurns(sessionOptions, record.maxTurns)) {
    return null;
  }
  if (!assignSessionSystemPrompt(sessionOptions, record.systemPrompt)) {
    return null;
  }

  return sessionOptions;
}

function assignSessionModel(options: QueueSessionOptions, value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  options.model = value;
  return true;
}

function assignSessionAllowedTools(options: QueueSessionOptions, value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
    return false;
  }
  options.allowedTools = value;
  return true;
}

function assignSessionMaxTurns(options: QueueSessionOptions, value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  options.maxTurns = Math.max(1, Math.round(value));
  return true;
}

function assignSessionSystemPrompt(options: QueueSessionOptions, value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === "string") {
    options.systemPrompt = value;
    return true;
  }
  const systemPrompt = asRecord(value);
  if (!systemPrompt || typeof systemPrompt.append !== "string") {
    return false;
  }
  options.systemPrompt = { append: systemPrompt.append };
  return true;
}

function parseOwnerGeneration(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseNonNegativeInteger(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

export function parseQueueRequest(raw: unknown): QueueRequest | null {
  const request = asRecord(raw);
  if (!request || typeof request.type !== "string" || typeof request.requestId !== "string") {
    return null;
  }

  const ownerGeneration = parseOwnerGeneration(request.ownerGeneration);
  if (ownerGeneration === null) {
    return null;
  }

  return parseTypedQueueRequest(
    request,
    parseQueueRequestContext(request.requestId, ownerGeneration, request.timeoutMs),
  );
}

type QueueRequestContext = {
  requestId: string;
  ownerGeneration: number | undefined;
  timeoutMs: number | undefined;
};

function parseQueueRequestContext(
  requestId: string,
  ownerGeneration: number | undefined,
  timeoutRaw: unknown,
): QueueRequestContext {
  return {
    requestId,
    ownerGeneration,
    timeoutMs: parsePositiveTimeout(timeoutRaw),
  };
}

function parsePositiveTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function parseTypedQueueRequest(
  request: Record<string, unknown>,
  context: QueueRequestContext,
): QueueRequest | null {
  switch (request.type) {
    case "submit_prompt":
      return parseSubmitRequest(request, context);
    case "cancel_prompt":
      return {
        type: "cancel_prompt",
        requestId: context.requestId,
        ownerGeneration: context.ownerGeneration,
      };
    case "close_session":
      return { type: "close_session", ...context };
    case "set_mode":
      return parseStringFieldRequest(request, context, "set_mode", "modeId");
    case "set_model":
      return parseStringFieldRequest(request, context, "set_model", "modelId");
    case "set_config_option":
      return parseSetConfigOptionRequest(request, context);
    default:
      return null;
  }
}

function parseSubmitRequest(
  request: Record<string, unknown>,
  context: QueueRequestContext,
): QueueSubmitRequest | null {
  const parsed = parseSubmitRequestFields(request);
  if (!parsed) {
    return null;
  }

  return {
    type: "submit_prompt",
    requestId: context.requestId,
    ownerGeneration: context.ownerGeneration,
    message: parsed.message,
    prompt: parsed.prompt ?? textPrompt(parsed.message),
    permissionMode: parsed.permissionMode,
    ...(parsed.resumePolicy !== undefined ? { resumePolicy: parsed.resumePolicy } : {}),
    nonInteractivePermissions: parsed.nonInteractivePermissions,
    ...(parsed.permissionPolicy !== undefined ? { permissionPolicy: parsed.permissionPolicy } : {}),
    timeoutMs: context.timeoutMs,
    ...(parsed.suppressSdkConsoleErrors !== undefined
      ? { suppressSdkConsoleErrors: parsed.suppressSdkConsoleErrors }
      : {}),
    ...(parsed.promptRetries !== undefined ? { promptRetries: parsed.promptRetries } : {}),
    waitForCompletion: parsed.waitForCompletion,
    ...(parsed.sessionOptions !== undefined ? { sessionOptions: parsed.sessionOptions } : {}),
  };
}

type ParsedSubmitRequestFields = Pick<
  QueueSubmitRequest,
  | "message"
  | "prompt"
  | "permissionMode"
  | "resumePolicy"
  | "nonInteractivePermissions"
  | "permissionPolicy"
  | "suppressSdkConsoleErrors"
  | "promptRetries"
  | "waitForCompletion"
  | "sessionOptions"
>;

function parseSubmitRequestFields(
  request: Record<string, unknown>,
): ParsedSubmitRequestFields | null {
  const parsed = {
    message: typeof request.message === "string" ? request.message : null,
    prompt: parseOptionalValue(request.prompt, isPromptInput),
    permissionMode: parseRequiredValue(request.permissionMode, isPermissionMode),
    resumePolicy: parseOptionalValue(request.resumePolicy, isSessionResumePolicy),
    nonInteractivePermissions: parseOptionalValue(
      request.nonInteractivePermissions,
      isNonInteractivePermissionPolicy,
    ),
    permissionPolicy: parseOptionalValue(request.permissionPolicy, isPermissionPolicy),
    suppressSdkConsoleErrors: parseOptionalBoolean(request.suppressSdkConsoleErrors),
    promptRetries: parseNonNegativeInteger(request.promptRetries),
    waitForCompletion:
      typeof request.waitForCompletion === "boolean" ? request.waitForCompletion : null,
    sessionOptions: parseSessionOptions(request.sessionOptions),
  };
  if (Object.values(parsed).some((value) => value === null)) {
    return null;
  }
  return parsed as ParsedSubmitRequestFields;
}

function parseOptionalValue<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): T | undefined | null {
  if (value == null) {
    return undefined;
  }
  return guard(value) ? value : null;
}

function parseRequiredValue<T>(value: unknown, guard: (value: unknown) => value is T): T | null {
  return guard(value) ? value : null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value == null) {
    return undefined;
  }
  return typeof value === "boolean" ? value : null;
}

function parseStringFieldRequest<TType extends "set_mode" | "set_model">(
  request: Record<string, unknown>,
  context: QueueRequestContext,
  type: TType,
  field: "modeId" | "modelId",
): Extract<QueueRequest, { type: TType }> | null {
  const value = parseNonEmptyString(request[field]);
  if (!value) {
    return null;
  }
  return { type, ...context, [field]: value } as Extract<QueueRequest, { type: TType }>;
}

function parseSetConfigOptionRequest(
  request: Record<string, unknown>,
  context: QueueRequestContext,
): QueueSetConfigOptionRequest | null {
  const configId = parseNonEmptyString(request.configId);
  const value = parseNonEmptyString(request.value);
  if (!configId || !value) {
    return null;
  }
  return { type: "set_config_option", ...context, configId, value };
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value;
}

function parseSessionSendResult(raw: unknown): SessionSendResult | null {
  const result = asRecord(raw);
  if (!result || !hasValidSessionSendResultCore(result)) {
    return null;
  }

  const permissionStats = asRecord(result.permissionStats);
  const record = asRecord(result.record);
  if (!permissionStats || !record) {
    return null;
  }

  if (!hasValidPermissionStats(permissionStats)) {
    return null;
  }

  if (!hasValidSessionRecordShape(record)) {
    return null;
  }

  return result as SessionSendResult;
}

function hasValidSessionSendResultCore(result: Record<string, unknown>): boolean {
  return (
    typeof result.stopReason === "string" &&
    typeof result.sessionId === "string" &&
    typeof result.resumed === "boolean"
  );
}

function hasValidPermissionStats(permissionStats: Record<string, unknown>): boolean {
  return ["requested", "approved", "denied", "cancelled"].every(
    (key) => typeof permissionStats[key] === "number",
  );
}

function hasValidSessionRecordShape(record: Record<string, unknown>): boolean {
  return (
    hasStringFields(record, [
      "acpxRecordId",
      "acpSessionId",
      "agentCommand",
      "cwd",
      "createdAt",
      "lastUsedAt",
      "updated_at",
    ]) &&
    Array.isArray(record.messages) &&
    typeof record.lastSeq === "number" &&
    Number.isInteger(record.lastSeq) &&
    !!record.eventLog &&
    typeof record.eventLog === "object"
  );
}

function hasStringFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

export function parseQueueOwnerMessage(raw: unknown): QueueOwnerMessage | null {
  const message = asRecord(raw);
  if (!message || typeof message.type !== "string" || typeof message.requestId !== "string") {
    return null;
  }
  const ownerGeneration = parseOwnerGeneration(message.ownerGeneration);
  if (ownerGeneration === null) {
    return null;
  }

  return parseTypedQueueOwnerMessage(message as TypedQueueOwnerRecord, {
    requestId: message.requestId,
    ownerGeneration,
  });
}

type QueueOwnerMessageContext = {
  requestId: string;
  ownerGeneration: number | undefined;
};

type TypedQueueOwnerRecord = Record<string, unknown> & { type: string };

function parseTypedQueueOwnerMessage(
  message: TypedQueueOwnerRecord,
  context: QueueOwnerMessageContext,
): QueueOwnerMessage | null {
  const parser = queueOwnerMessageParser(message.type);
  return parser ? parser(message, context) : null;
}

type QueueOwnerMessageParser = (
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
) => QueueOwnerMessage | null;

const QUEUE_OWNER_MESSAGE_PARSERS: Record<string, QueueOwnerMessageParser> = {
  accepted: (_message, context) => ({ type: "accepted", ...context }),
  event: parseEventOwnerMessage,
  permission_escalation: parsePermissionEscalationOwnerMessage,
  result: parseResultOwnerMessage,
  cancel_result: (message, context) =>
    parseBooleanResultOwnerMessage(message, context, "cancel_result", "cancelled"),
  close_session_result: (message, context) =>
    parseBooleanResultOwnerMessage(message, context, "close_session_result", "closed"),
  set_mode_result: (message, context) =>
    parseStringResultOwnerMessage(message, context, "set_mode_result", "modeId"),
  set_model_result: parseSetModelOwnerMessage,
  set_config_option_result: parseSetConfigOptionOwnerMessage,
  error: parseErrorOwnerMessage,
};

function queueOwnerMessageParser(type: string): QueueOwnerMessageParser | undefined {
  return Object.hasOwn(QUEUE_OWNER_MESSAGE_PARSERS, type)
    ? QUEUE_OWNER_MESSAGE_PARSERS[type]
    : undefined;
}

function parseEventOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerEventMessage | null {
  if (!isAcpJsonRpcMessage(message.message)) {
    return null;
  }
  return { type: "event", ...context, message: message.message };
}

function parsePermissionEscalationOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerPermissionEscalationMessage | null {
  if (!isPermissionEscalationEvent(message.event)) {
    return null;
  }
  return { type: "permission_escalation", ...context, event: message.event };
}

function parseResultOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerResultMessage | null {
  const result = parseSessionSendResult(message.result);
  if (!result) {
    return null;
  }
  return { type: "result", ...context, result };
}

function parseBooleanResultOwnerMessage<TType extends "cancel_result" | "close_session_result">(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
  type: TType,
  field: "cancelled" | "closed",
): Extract<QueueOwnerMessage, { type: TType }> | null {
  if (typeof message[field] !== "boolean") {
    return null;
  }
  return { type, ...context, [field]: message[field] } as Extract<
    QueueOwnerMessage,
    { type: TType }
  >;
}

function parseStringResultOwnerMessage<TType extends "set_mode_result" | "set_model_result">(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
  type: TType,
  field: "modeId" | "modelId",
): Extract<QueueOwnerMessage, { type: TType }> | null {
  if (typeof message[field] !== "string") {
    return null;
  }
  return { type, ...context, [field]: message[field] } as Extract<
    QueueOwnerMessage,
    { type: TType }
  >;
}

function parseSetModelOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerSetModelResultMessage | null {
  if (typeof message.modelId !== "string") {
    return null;
  }
  const response = asRecord(message.response);
  if (message.response !== undefined && (!response || !Array.isArray(response.configOptions))) {
    return null;
  }
  return {
    type: "set_model_result",
    ...context,
    modelId: message.modelId,
    ...(response ? { response: response as SetSessionConfigOptionResponse } : {}),
  };
}

function parseSetConfigOptionOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerSetConfigOptionResultMessage | null {
  const response = asRecord(message.response);
  if (!response || !Array.isArray(response.configOptions)) {
    return null;
  }
  return {
    type: "set_config_option_result",
    ...context,
    response: response as SetSessionConfigOptionResponse,
  };
}

function parseErrorOwnerMessage(
  message: Record<string, unknown>,
  context: QueueOwnerMessageContext,
): QueueOwnerErrorMessage | null {
  if (!isValidOwnerErrorCore(message)) {
    return null;
  }

  const outputAlreadyEmitted =
    typeof message.outputAlreadyEmitted === "boolean" ? message.outputAlreadyEmitted : undefined;

  return {
    type: "error",
    ...context,
    code: message.code,
    detailCode: parseNonEmptyString(message.detailCode) ?? undefined,
    origin: message.origin,
    message: message.message,
    retryable: typeof message.retryable === "boolean" ? message.retryable : undefined,
    acp: toAcpErrorPayload(message.acp),
    ...(outputAlreadyEmitted === undefined ? {} : { outputAlreadyEmitted }),
  };
}

function isValidOwnerErrorCore(message: Record<string, unknown>): message is Record<
  string,
  unknown
> & {
  code: OutputErrorCode;
  origin: OutputErrorOrigin;
  message: string;
} {
  return (
    typeof message.message === "string" &&
    isOutputErrorCode(message.code) &&
    isOutputErrorOrigin(message.origin)
  );
}
