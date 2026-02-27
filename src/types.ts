import type {
  AgentCapabilities,
  SessionConfigOption,
  SessionNotification,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const OUTPUT_FORMATS = ["text", "json", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AUTH_POLICIES = ["skip", "fail"] as const;
export type AuthPolicy = (typeof AUTH_POLICIES)[number];

export const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"] as const;
export type NonInteractivePermissionPolicy =
  (typeof NON_INTERACTIVE_PERMISSION_POLICIES)[number];

export const OUTPUT_STREAMS = ["prompt", "control"] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];

export const ACPX_EVENT_SCHEMA = "acpx.event.v1" as const;
export const ACPX_EVENT_OUTPUT_STREAMS = ["output", "thought"] as const;
export type AcpxEventOutputStream = (typeof ACPX_EVENT_OUTPUT_STREAMS)[number];

export const OUTPUT_ERROR_CODES = [
  "NO_SESSION",
  "TIMEOUT",
  "PERMISSION_DENIED",
  "PERMISSION_PROMPT_UNAVAILABLE",
  "RUNTIME",
  "USAGE",
] as const;
export type OutputErrorCode = (typeof OUTPUT_ERROR_CODES)[number];

export const OUTPUT_ERROR_ORIGINS = ["cli", "runtime", "queue", "acp"] as const;
export type OutputErrorOrigin = (typeof OUTPUT_ERROR_ORIGINS)[number];

export const QUEUE_ERROR_DETAIL_CODES = [
  "QUEUE_OWNER_CLOSED",
  "QUEUE_OWNER_SHUTTING_DOWN",
  "QUEUE_REQUEST_INVALID",
  "QUEUE_REQUEST_PAYLOAD_INVALID_JSON",
  "QUEUE_ACK_MISSING",
  "QUEUE_DISCONNECTED_BEFORE_ACK",
  "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
  "QUEUE_PROTOCOL_INVALID_JSON",
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
  "QUEUE_NOT_ACCEPTING_REQUESTS",
  "QUEUE_CONTROL_REQUEST_FAILED",
  "QUEUE_RUNTIME_PROMPT_FAILED",
] as const;
export type QueueErrorDetailCode = (typeof QUEUE_ERROR_DETAIL_CODES)[number];

export type OutputErrorAcpPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type PermissionStats = {
  requested: number;
  approved: number;
  denied: number;
  cancelled: number;
};

export type ClientOperationMethod =
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type ClientOperationStatus = "running" | "completed" | "failed";

export type ClientOperation = {
  method: ClientOperationMethod;
  status: ClientOperationStatus;
  summary: string;
  details?: string;
  timestamp: string;
};

export type AcpxEventKind =
  | "turn_started"
  | "output_delta"
  | "tool_call"
  | "plan"
  | "update"
  | "client_operation"
  | "turn_done"
  | "error"
  | "session_ensured"
  | "cancel_requested"
  | "cancel_result"
  | "mode_set"
  | "config_set"
  | "status_snapshot"
  | "session_closed";

type AcpxEventEnvelope = {
  schema: typeof ACPX_EVENT_SCHEMA;
  event_id: string;
  session_id: string;
  acp_session_id?: string;
  agent_session_id?: string;
  request_id?: string;
  seq: number;
  ts: string;
};

export type AcpxEvent =
  | (AcpxEventEnvelope & {
      kind: "turn_started";
      data: {
        mode: "prompt";
        resumed: boolean;
        input_preview?: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "output_delta";
      data: {
        stream: AcpxEventOutputStream;
        text: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "tool_call";
      data: {
        tool_call_id?: string;
        title?: string;
        status?: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "plan";
      data: {
        entries: Array<{
          content: string;
          status: string;
          priority: string;
        }>;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "update";
      data: {
        update: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "client_operation";
      data: {
        method: ClientOperationMethod;
        status: ClientOperationStatus;
        summary: string;
        details?: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "turn_done";
      data: {
        stop_reason: StopReason;
        permission_stats?: PermissionStats;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "error";
      data: {
        code: OutputErrorCode;
        detail_code?: string;
        origin?: OutputErrorOrigin;
        message: string;
        retryable?: boolean;
        acp_error?: OutputErrorAcpPayload;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "session_ensured";
      data: {
        created: boolean;
        name?: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "cancel_requested";
      data: Record<string, never>;
    })
  | (AcpxEventEnvelope & {
      kind: "cancel_result";
      data: {
        cancelled: boolean;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "mode_set";
      data: {
        mode_id: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "config_set";
      data: {
        config_id: string;
        value: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "status_snapshot";
      data: {
        status: "alive" | "dead" | "no-session";
        pid?: number;
        summary?: string;
      };
    })
  | (AcpxEventEnvelope & {
      kind: "session_closed";
      data: {
        reason: "close";
      };
    });

export type AcpxEventDraft = Omit<
  AcpxEvent,
  "schema" | "event_id" | "session_id" | "seq" | "ts"
>;

export type SessionEventLog = {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
  last_write_at?: string;
  last_write_error?: string | null;
};

export type OutputFormatterContext = {
  sessionId: string;
  acpSessionId?: string;
  agentSessionId?: string;
  requestId?: string;
  nextSeq?: number;
};

export type OutputPolicy = {
  format: OutputFormat;
  jsonStrict: boolean;
  suppressNonJsonStderr: boolean;
  queueErrorAlreadyEmitted: boolean;
  suppressSdkConsoleErrors: boolean;
};

export type OutputErrorEmissionPolicy = {
  queueErrorAlreadyEmitted: boolean;
};

export interface OutputFormatter {
  setContext(context: OutputFormatterContext): void;
  onEvent(event: AcpxEvent): void;
  onSessionUpdate(notification: SessionNotification): void;
  onClientOperation(operation: ClientOperation): void;
  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void;
  onDone(stopReason: StopReason): void;
  flush(): void;
}

export type AcpClientOptions = {
  agentCommand: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
};

export const SESSION_RECORD_SCHEMA = "acpx.session.v1" as const;
export const SESSION_THREAD_VERSION = "0.3.0" as const;

export type SessionThreadImage = {
  source: string;
  size?: {
    width: number;
    height: number;
  } | null;
};

export type SessionThreadUserContent =
  | {
      Text: string;
    }
  | {
      Mention: {
        uri: string;
        content: string;
      };
    }
  | {
      Image: SessionThreadImage;
    };

export type SessionThreadToolUse = {
  id: string;
  name: string;
  raw_input: string;
  input: unknown;
  is_input_complete: boolean;
  thought_signature?: string | null;
};

export type SessionThreadToolResultContent =
  | {
      Text: string;
    }
  | {
      Image: SessionThreadImage;
    };

export type SessionThreadToolResult = {
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  content: SessionThreadToolResultContent;
  output?: unknown;
};

export type SessionThreadAgentContent =
  | {
      Text: string;
    }
  | {
      Thinking: {
        text: string;
        signature?: string | null;
      };
    }
  | {
      RedactedThinking: string;
    }
  | {
      ToolUse: SessionThreadToolUse;
    };

export type SessionThreadUserMessage = {
  id: string;
  content: SessionThreadUserContent[];
};

export type SessionThreadAgentMessage = {
  content: SessionThreadAgentContent[];
  tool_results: Record<string, SessionThreadToolResult>;
  reasoning_details?: unknown | null;
};

export type SessionThreadMessage =
  | {
      User: SessionThreadUserMessage;
    }
  | {
      Agent: SessionThreadAgentMessage;
    }
  | "Resume";

export type SessionThreadTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type SessionThread = {
  version: typeof SESSION_THREAD_VERSION;
  title?: string | null;
  messages: SessionThreadMessage[];
  updated_at: string;
  detailed_summary?: string | null;
  initial_project_snapshot?: unknown | null;
  cumulative_token_usage: SessionThreadTokenUsage;
  request_token_usage: Record<string, SessionThreadTokenUsage>;
  model?: unknown | null;
  profile?: unknown | null;
  imported: boolean;
  subagent_context?: {
    parent_session_id: string;
    depth: number;
  } | null;
  speed?: "standard" | "fast" | null;
  thinking_enabled: boolean;
  thinking_effort?: string | null;
};

export type SessionAcpxState = {
  current_mode_id?: string;
  available_commands?: string[];
  config_options?: SessionConfigOption[];
};

export type SessionRecord = {
  schema: typeof SESSION_RECORD_SCHEMA;
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  lastSeq: number;
  lastRequestId?: string;
  eventLog: SessionEventLog;
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: NodeJS.Signals | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  thread: SessionThread;
  acpx?: SessionAcpxState;
};

export type RunPromptResult = {
  stopReason: StopReason;
  permissionStats: PermissionStats;
  sessionId: string;
};

export type SessionSendResult = RunPromptResult & {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetModeResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetConfigOptionResult = {
  record: SessionRecord;
  response: SetSessionConfigOptionResponse;
  resumed: boolean;
  loadError?: string;
};

export type SessionEnsureResult = {
  record: SessionRecord;
  created: boolean;
};

export type SessionEnqueueResult = {
  queued: true;
  sessionId: string;
  requestId: string;
};

export type SessionSendOutcome = SessionSendResult | SessionEnqueueResult;
