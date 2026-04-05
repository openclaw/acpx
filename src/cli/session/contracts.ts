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
  PermissionMode,
  PromptInput,
  SessionNotification,
  SessionResumePolicy,
  SessionRecord,
} from "../../types.js";

type TimedRunOptions = {
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
  cwd: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
  promptRetries?: number;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  prompt: PromptInput;
  resumePolicy?: SessionResumePolicy;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  client?: AcpClient;
  promptRetries?: number;
} & TimedRunOptions;

export type SessionEnsureOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  walkBoundary?: string;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetModelOptions = {
  sessionId: string;
  modelId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionCreateWithClientResult = {
  record: SessionRecord;
  client: AcpClient;
};

export type { SessionAgentOptions };
