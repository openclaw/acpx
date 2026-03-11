import {
  extractAcpError,
  formatUnknownErrorMessage,
  isAcpResourceNotFoundError,
} from "./acp-error-shapes.js";
import {
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "./errors.js";
import {
  EXIT_CODES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type ExitCode,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "./types.js";

const AUTH_REQUIRED_ACP_CODES = new Set([-32000]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";
const READ_ONLY_HINT_TEXT =
  "Hint: acpx permission flags (--approve-all/--approve-reads/--deny-all) control client-side approvals, not adapter sandbox mode. If Codex remains read-only, run `acpx codex set-mode auto` or `acpx codex set-mode full-access`.";

type ErrorMeta = {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizedOutputError = {
  code: OutputErrorCode;
  message: string;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizeOutputErrorOptions = {
  defaultCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isAuthRequiredMessage(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return (
    normalized.includes("auth required") ||
    normalized.includes("authentication required") ||
    normalized.includes("authorization required") ||
    normalized.includes("credential required") ||
    normalized.includes("credentials required") ||
    normalized.includes("token required") ||
    normalized.includes("login required")
  );
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function containsReadOnlySandboxSignal(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("read-only sandbox")) {
    return true;
  }
  if (normalized.includes("readonly sandbox")) {
    return true;
  }
  return normalized.includes("read-only") && normalized.includes("sandbox");
}

function shouldAppendReadOnlyHint(
  message: string,
  acp: OutputErrorAcpPayload | undefined,
): boolean {
  if (message.includes("acpx permission flags")) {
    return false;
  }
  if (containsReadOnlySandboxSignal(message)) {
    return true;
  }

  if (!acp) {
    return false;
  }
  if (containsReadOnlySandboxSignal(acp.message)) {
    return true;
  }

  const data = asRecord(acp.data);
  if (!data) {
    return false;
  }
  return (
    containsReadOnlySandboxSignal(readStringField(data, "details")) ||
    containsReadOnlySandboxSignal(readStringField(data, "detail")) ||
    containsReadOnlySandboxSignal(readStringField(data, "reason"))
  );
}

function isAcpAuthRequiredPayload(acp: OutputErrorAcpPayload | undefined): boolean {
  if (!acp) {
    return false;
  }
  if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) {
    return false;
  }
  if (isAuthRequiredMessage(acp.message)) {
    return true;
  }

  const data = asRecord(acp.data);
  if (!data) {
    return false;
  }

  if (data.authRequired === true) {
    return true;
  }

  const methodId = data.methodId;
  if (typeof methodId === "string" && methodId.trim().length > 0) {
    return true;
  }

  const methods = data.methods;
  if (Array.isArray(methods) && methods.length > 0) {
    return true;
  }

  return false;
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function readOutputErrorMeta(error: unknown): ErrorMeta {
  const record = asRecord(error);
  if (!record) {
    return {};
  }

  const outputCode = isOutputErrorCode(record.outputCode) ? record.outputCode : undefined;
  const detailCode =
    typeof record.detailCode === "string" && record.detailCode.trim().length > 0
      ? record.detailCode
      : undefined;
  const origin = isOutputErrorOrigin(record.origin) ? record.origin : undefined;
  const retryable = typeof record.retryable === "boolean" ? record.retryable : undefined;

  const acp = extractAcpError(record.acp);
  return {
    outputCode,
    detailCode,
    origin,
    retryable,
    acp,
  };
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isNoSessionLike(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSessionError";
}

function isUsageLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "CommanderError" ||
    error.name === "InvalidArgumentError" ||
    asRecord(error)?.code === "commander.invalidArgument"
  );
}

export function formatErrorMessage(error: unknown): string {
  return formatUnknownErrorMessage(error);
}

export { extractAcpError, isAcpResourceNotFoundError };

export function isAcpQueryClosedBeforeResponseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp || acp.code !== -32603) {
    return false;
  }

  const data = asRecord(acp.data);
  const details = data?.details;
  if (typeof details !== "string") {
    return false;
  }

  return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}

function mapErrorCode(error: unknown): OutputErrorCode | undefined {
  if (error instanceof PermissionPromptUnavailableError) {
    return "PERMISSION_PROMPT_UNAVAILABLE";
  }
  if (error instanceof PermissionDeniedError) {
    return "PERMISSION_DENIED";
  }
  if (isTimeoutLike(error)) {
    return "TIMEOUT";
  }
  if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  if (isUsageLike(error)) {
    return "USAGE";
  }
  return undefined;
}

export function normalizeOutputError(
  error: unknown,
  options: NormalizeOutputErrorOptions = {},
): NormalizedOutputError {
  const meta = readOutputErrorMeta(error);
  const mapped = mapErrorCode(error);
  let code = mapped ?? options.defaultCode ?? "RUNTIME";

  if (meta.outputCode) {
    code = meta.outputCode;
  }

  if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) {
    code = "NO_SESSION";
  }

  const acp = options.acp ?? meta.acp ?? extractAcpError(error);
  const detailCode =
    meta.detailCode ??
    options.detailCode ??
    (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp)
      ? "AUTH_REQUIRED"
      : undefined);
  const baseMessage = formatErrorMessage(error);
  const message = shouldAppendReadOnlyHint(baseMessage, acp)
    ? `${baseMessage}\n${READ_ONLY_HINT_TEXT}`
    : baseMessage;
  return {
    code,
    message,
    detailCode,
    origin: meta.origin ?? options.origin,
    retryable: meta.retryable ?? options.retryable,
    acp,
  };
}

export function exitCodeForOutputErrorCode(code: OutputErrorCode): ExitCode {
  switch (code) {
    case "USAGE":
      return EXIT_CODES.USAGE;
    case "TIMEOUT":
      return EXIT_CODES.TIMEOUT;
    case "NO_SESSION":
      return EXIT_CODES.NO_SESSION;
    case "PERMISSION_DENIED":
    case "PERMISSION_PROMPT_UNAVAILABLE":
      return EXIT_CODES.PERMISSION_DENIED;
    case "RUNTIME":
    default:
      return EXIT_CODES.ERROR;
  }
}
