export const ACP_ERROR_CODES = [
  "ACP_BACKEND_MISSING",
  "ACP_BACKEND_UNAVAILABLE",
  "ACP_BACKEND_UNSUPPORTED_CONTROL",
  "ACP_DISPATCH_DISABLED",
  "ACP_INVALID_RUNTIME_OPTION",
  "ACP_SESSION_INIT_FAILED",
  "ACP_TURN_FAILED",
] as const;

export type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];

export class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  override readonly cause?: unknown;

  constructor(code: AcpRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AcpRuntimeError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export function isAcpRuntimeError(value: unknown): value is AcpRuntimeError {
  return value instanceof AcpRuntimeError;
}
