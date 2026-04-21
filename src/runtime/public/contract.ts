import type {
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  SessionRecord,
} from "../../types.js";

export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeSessionMode = "persistent" | "oneshot";

export type AcpSessionUpdateTag =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "usage_update"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_info_update"
  | "plan"
  | (string & {});

export type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
};

export type AcpRuntimeTurnAttachment = {
  mediaType: string;
  data: string;
};

export type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};

export type AcpRuntimeStatus = {
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  details?: Record<string, unknown>;
};

export type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};

export type AcpRuntimeEvent =
  | {
      type: "text_delta";
      text: string;
      stream?: "output" | "thought";
      tag?: AcpSessionUpdateTag;
    }
  | {
      type: "status";
      text: string;
      tag?: AcpSessionUpdateTag;
      used?: number;
      size?: number;
    }
  | {
      type: "tool_call";
      text: string;
      tag?: AcpSessionUpdateTag;
      toolCallId?: string;
      status?: string;
      title?: string;
    }
  /**
   * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "done";
      stopReason?: string;
    }
  /**
   * Compatibility failure event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
    };

export type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  retryable?: boolean;
};

export type AcpRuntimeTurnResult =
  | {
      status: "completed";
      stopReason?: string;
    }
  | {
      status: "cancelled";
      stopReason?: string;
    }
  | {
      status: "failed";
      error: AcpRuntimeTurnResultError;
    };

export interface AcpRuntimeTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
}

export interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  /**
   * Compatibility adapter for consumers that expect terminal status in the
   * event stream. Prefer startTurn(...), which separates live events from the
   * terminal result.
   */
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
  setMode?(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  setConfigOption?(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
}

export type AcpSessionRecord = SessionRecord;

export interface AcpSessionStore {
  load(sessionId: string): Promise<AcpSessionRecord | undefined>;
  save(record: AcpSessionRecord): Promise<void>;
}

export interface AcpAgentRegistry {
  resolve(agentName: string): string;
  list(): string[];
}

export type AcpRuntimeOptions = {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
};

export type AcpFileSessionStoreOptions = {
  stateDir: string;
};
