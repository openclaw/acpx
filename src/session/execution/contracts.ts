import type { AcpClient } from "../../acp/client.js";
import type { SessionAgentOptions } from "../../runtime/engine/session-options.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  ClientOperation,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionEscalationEvent,
  PermissionMode,
  PermissionPolicy,
  PromptInput,
  AgentSessionListResult,
  SessionNotification,
  SessionResumePolicy,
  SessionRecord,
} from "../../types.js";

export type SessionConnectionOptions = {
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  verbose?: boolean;
  timeoutMs?: number;
};

export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;

export function normalizeQueueOwnerTtlMs(ttlMs: number | undefined): number {
  if (ttlMs == null) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  // 0 means keep alive forever (no TTL)
  return Math.round(ttlMs);
}

export type RunOnceOptions = {
  agentCommand: string;
  agentArgv?: string[];
  cwd: string;
  prompt: PromptInput;
  permissionMode: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  suppressSdkConsoleErrors?: boolean;
  sessionOptions?: SessionAgentOptions;
  configOptions?: Array<{ configId: string; value: string }>;
  promptRetries?: number;
} & SessionConnectionOptions;

export type SessionCreateOptions = {
  signal?: AbortSignal;
  agentCommand: string;
  agentArgv?: string[];
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  sessionOptions?: SessionAgentOptions;
  onModelWarning?: (message: string) => void;
  handleProcessInterrupts?: boolean;
} & SessionConnectionOptions;

export type SessionSendOptions = {
  sessionId: string;
  requestId?: string;
  requireSharedRuntime?: boolean;
  onQueueAccepted?: () => void;
  onPromptStarted?: () => void;
  /** Detaches this submitting client without cancelling the accepted prompt. */
  signal?: AbortSignal;
  /** Explicit acpx owner entry point for embedding hosts; never persisted. */
  queueOwnerArgs?: readonly string[];
  prompt: PromptInput;
  resumePolicy?: SessionResumePolicy;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  permissionMode: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  client?: AcpClient;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
} & SessionConnectionOptions;

export type SessionEnsureOptions = SessionCreateOptions & {
  walkBoundary?: string;
};

export type SessionListOptions = {
  agentCommand: string;
  agentArgv?: string[];
  cwd: string;
  cursor?: string;
  filterCwd?: string;
  permissionMode: PermissionMode;
  permissionPolicy?: PermissionPolicy;
} & SessionConnectionOptions;

export type SessionListResult = AgentSessionListResult | undefined;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

/** Identifies a session control request that only a running queue owner serves. */
export type SessionControlOwnerOptions = {
  sessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
  /**
   * Last chance to refuse, invoked immediately before the request is written to
   * the owner's socket. A throw means nothing was sent.
   */
  assertDispatch?: () => void;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
} & SessionConnectionOptions;

export type SessionSetModelOptions = {
  sessionId: string;
  modelId: string;
} & SessionConnectionOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
} & SessionConnectionOptions;

export type SessionCreateWithClientResult = {
  record: SessionRecord;
  client: AcpClient;
};

export type { SessionAgentOptions };
