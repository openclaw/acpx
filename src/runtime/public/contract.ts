import type {
  SetSessionConfigOptionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  AcpElicitationHandler,
  AcpElicitationMode,
  AcpPermissionDecision,
  AcpPermissionRequest,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionPolicy,
  SessionRecord,
} from "../../types.js";
import type { SessionAgentOptions } from "../engine/session-options.js";

export type { SessionAgentOptions, SystemPromptOption } from "../engine/session-options.js";

export type {
  AcpElicitationHandler,
  AcpElicitationMode,
  AcpElicitationContext,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionDecision,
  AcpPermissionRequest,
  PermissionPolicy,
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
  /**
   * Per-session agent options applied when a fresh ACP session is created.
   * Threaded into `_meta.systemPrompt` (and `_meta.claudeCode.options.*`)
   * on the underlying `session/new` request, and persisted onto the new
   * record. Ignored when an existing persistent session is reused — system
   * prompts are fixed at `newSession` time, so changing them requires a
   * different sessionKey or closing the prior record first.
   */
  sessionOptions?: SessionAgentOptions;
};

export type AcpRuntimeTurnAttachment = {
  /**
   * Media type for binary prompt attachments. The runtime currently maps
   * image/* and audio/* attachments to ACP prompt content blocks.
   */
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
  /** Handles ACP elicitation requests owned by this prompt turn. */
  onElicitation?: AcpElicitationHandler;
};

export type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};

export type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
};

/**
 * Cumulative session cost as reported by the agent. Mirrors ACP's
 * `Cost`, but both fields are optional here because not every adapter
 * populates them on every event.
 */
export type AcpRuntimeUsageCost = {
  amount?: number;
  currency?: string;
};

/**
 * Per-turn token breakdown. Sourced from final prompt response usage or
 * `UsageUpdate._meta.usage` on adapters that populate it. All fields optional —
 * consumers should treat missing fields as "unknown", not "zero".
 */
export type AcpRuntimeUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

/**
 * Agent-advertised slash command. The runtime only surfaces enough to
 * drive a picker UI ("does the agent advertise /compact?"). The full
 * `AvailableCommandInput` schema from ACP is intentionally not plumbed
 * through.
 */
export type AcpRuntimeAvailableCommand = {
  name: string;
  description?: string;
  /** True/false when ACP advertised whether this command has an input schema. */
  hasInput?: boolean;
};

/**
 * Session-level usage roll-up surfaced through `getStatus()`. The
 * reducer persists the breakdowns onto the session record; this type
 * exposes them on the runtime contract.
 */
export type AcpRuntimeSessionUsage = {
  cumulative?: AcpRuntimeUsageBreakdown;
  /** Cumulative session cost when the agent reported it. */
  cost?: AcpRuntimeUsageCost;
  /** Keyed by user-message id, matching the persisted reducer state. */
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
};

export type AcpRuntimeStatus = {
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  models?: AcpRuntimeSessionModels;
  /** Token usage and cost from the persisted session record. */
  usage?: AcpRuntimeSessionUsage;
  /**
   * Commands the agent advertised via `available_commands_update`.
   * Sourced from the persisted record — older session files only
   * preserve `name`, so `description` and `hasInput` may be undefined
   * even when a more recent live event would have carried both.
   */
  availableCommands?: AcpRuntimeAvailableCommand[];
  details?: Record<string, unknown>;
};

export type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};

/**
 * Fail-closed origin metadata on `text_delta` events.
 * Only these optional string fields are preserved from ACP wire `_meta`.
 */
export type AcpTextDeltaOriginMeta = {
  origin?: string;
  kind?: string;
  source?: string;
};

export type AcpRuntimeEvent =
  | {
      type: "text_delta";
      text: string;
      stream?: "output" | "thought";
      tag?: AcpSessionUpdateTag;
      /**
       * Present when the originating ACP session update carried a non-empty
       * `messageId`. Absent when the wire payload had no id.
       * Opaque producer-supplied routing hint only: ACPX does not authenticate
       * this value. Do not treat it as proof of authorship or as an
       * authorization boundary. Useful for correlating chunks from the same
       * producer message when the adapter includes an id.
       */
      messageId?: string;
      /**
       * Allowlisted origin fields from the ACP update `_meta`.
       * Only the documented string keys `origin`, `kind`, and `source` are
       * preserved. All other keys (including nested objects and secret-like
       * producer-controlled names) are dropped. Omitted when none remain.
       * These values are opaque producer-supplied routing hints, not
       * authenticated authorship or provenance. Consumers must not use them
       * as an authorization boundary.
       */
      meta?: AcpTextDeltaOriginMeta;
    }
  | {
      type: "status";
      text: string;
      tag?: AcpSessionUpdateTag;
      used?: number;
      size?: number;
      /** Populated on `usage_update` events when the agent reported a cost. */
      cost?: AcpRuntimeUsageCost;
      /**
       * Populated on `usage_update` events when the agent attached a
       * per-turn breakdown via `_meta.usage` (Claude Code does this; not
       * every adapter does).
       */
      breakdown?: AcpRuntimeUsageBreakdown;
      /**
       * Populated on `available_commands_update` events. The list is a
       * normalized view of the wire payload — names, descriptions, and
       * a `hasInput` flag derived from whether the agent advertised a
       * non-null `input` schema.
       */
      availableCommands?: AcpRuntimeAvailableCommand[];
    }
  | {
      type: "tool_call";
      text: string;
      tag?: AcpSessionUpdateTag;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: ToolKind;
      locations?: ToolCallLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: ToolCallContent[];
    }
  /**
   * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "done";
      stopReason?: string;
      _meta?: Record<string, unknown> | null;
    }
  /**
   * Compatibility failure event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "error";
      message: string;
      code?: string;
      detailCode?: string;
      retryable?: boolean;
    };

export type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};

export type AcpRuntimeTurnResult =
  | {
      status: "completed";
      stopReason?: string;
      _meta?: Record<string, unknown> | null;
    }
  | {
      status: "cancelled";
      stopReason?: string;
      _meta?: Record<string, unknown> | null;
    }
  | {
      status: "failed";
      error: AcpRuntimeTurnResultError;
    };

export interface AcpRuntimeTurn {
  readonly requestId: string;
  /** Resolves after `connection.prompt()` returns its request promise. */
  readonly promptStarted: Promise<void>;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  /**
   * Canonical completion signal for the turn. Resolves only after final record
   * checkpoint/persistence and runtime client pooling or close cleanup attempts
   * have settled.
   */
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
  setConfigOption?(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<SetSessionConfigOptionResponse | void>;
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
  resolve(agentName: string): string | string[];
  list(): string[];
}

export type AcpRuntimeOptions = {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
  /** ACP elicitation modes the embedding host can render for prompt turns. */
  elicitationModes?: readonly AcpElicitationMode[];
  onPermissionRequest?: (
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
};

export type AcpFileSessionStoreOptions = {
  stateDir: string;
};
