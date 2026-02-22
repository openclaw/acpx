import type {
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
} from "./types.js";

type AcpxErrorOptions = ErrorOptions & {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export class AcpxOperationalError extends Error {
  readonly outputCode?: OutputErrorCode;
  readonly detailCode?: string;
  readonly origin?: OutputErrorOrigin;
  readonly retryable?: boolean;
  readonly acp?: OutputErrorAcpPayload;

  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.outputCode = options?.outputCode;
    this.detailCode = options?.detailCode;
    this.origin = options?.origin;
    this.retryable = options?.retryable;
    this.acp = options?.acp;
  }
}

export class SessionNotFoundError extends AcpxOperationalError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionResolutionError extends AcpxOperationalError {}

export class AgentSpawnError extends AcpxOperationalError {
  readonly agentCommand: string;

  constructor(agentCommand: string, cause?: unknown) {
    super(`Failed to spawn agent command: ${agentCommand}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.agentCommand = agentCommand;
  }
}

export class AuthPolicyError extends AcpxOperationalError {}

export class QueueConnectionError extends AcpxOperationalError {}

export class QueueProtocolError extends AcpxOperationalError {}

export class PermissionDeniedError extends AcpxOperationalError {}

export class PermissionPromptUnavailableError extends AcpxOperationalError {
  constructor() {
    super("Permission prompt unavailable in non-interactive mode");
  }
}
