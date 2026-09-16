import type {
  FlowBundledSessionEvent as PersistedSessionEvent,
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  FlowTraceEvent,
} from "../../../../src/flows/types.js";

export type {
  FlowArtifactRef,
  FlowActionReceipt,
  FlowConversationTrace,
  FlowDefinitionSnapshot,
  FlowEdge,
  FlowNodeOutcome,
  FlowNodeResult,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  FlowStepTrace,
  FlowTraceEvent,
} from "../../../../src/flows/types.js";

// Historical bundles can contain partial or adapter-specific message envelopes.
export type FlowBundledSessionEvent = Omit<PersistedSessionEvent, "message"> & {
  message: Record<string, unknown>;
};

export type RunBundleSummary = {
  runId: string;
  flowName: string;
  runTitle?: string;
  status: FlowRunState["status"];
  startedAt: string;
  finishedAt?: string;
  updatedAt?: string;
  currentNode?: string;
  path: string;
};

export type SessionRecord = {
  schema?: string;
  acpxRecordId?: string;
  acpSessionId?: string;
  agentCommand?: string;
  cwd?: string;
  name?: string;
  title?: string | null;
  messages?: unknown[];
  updated_at?: string;
  createdAt?: string;
  lastUsedAt?: string;
  lastSeq?: number;
  lastRequestId?: string;
  eventLog?: {
    active_path: string;
    segment_count: number;
    max_segment_bytes: number;
    max_segments: number;
    last_write_at?: string;
    last_write_error?: string | null;
  };
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: string | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  protocolVersion?: number;
  closed?: boolean;
  closedAt?: string;
  cumulative_token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    thought_tokens?: number;
    total_tokens?: number;
  };
  cumulative_cost?: {
    amount?: number;
    currency?: string;
  };
  request_token_usage?: Record<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      thought_tokens?: number;
      total_tokens?: number;
    }
  >;
  acpx?: {
    current_mode_id?: string;
    desired_mode_id?: string;
    current_model_id?: string;
    available_models?: string[];
    available_commands?: Array<{
      name: string;
      description?: string;
      has_input?: boolean;
    }>;
    config_options?: unknown[];
    session_options?: {
      model?: string;
      allowed_tools?: string[];
      max_turns?: number;
    };
  };
};

export type LoadedRunBundle = {
  sourceType: "sample" | "local" | "recent";
  sourceLabel: string;
  manifest: FlowRunManifest;
  flow: FlowDefinitionSnapshot;
  run: FlowRunState;
  live: Partial<FlowRunState> | null;
  steps: FlowStepRecord[];
  trace: FlowTraceEvent[];
  sessions: Record<
    string,
    {
      id: string;
      binding: FlowSessionBinding;
      record: SessionRecord;
      events: FlowBundledSessionEvent[];
    }
  >;
};

export type ViewerRunsState = {
  schema: "acpx.viewer-runs.v2";
  order: string[];
  runsById: Record<string, RunBundleSummary>;
};

export type ViewerRunLiveState = LoadedRunBundle & {
  schema: "acpx.viewer-run-live.v1";
};

export type ReplayProtocol = "acpx.replay.v1";

export type ReplayJsonPatchOperation =
  | {
      op: "add";
      path: string;
      value: unknown;
    }
  | {
      op: "replace";
      path: string;
      value: unknown;
    }
  | {
      op: "remove";
      path: string;
    }
  | {
      op: "move";
      from: string;
      path: string;
    }
  | {
      op: "copy";
      from: string;
      path: string;
    }
  | {
      op: "test";
      path: string;
      value: unknown;
    }
  | {
      op: "append";
      path: string;
      value: unknown;
    };

export type ReplayClientMessage =
  | {
      type: "hello";
      protocol: ReplayProtocol;
    }
  | {
      type: "subscribe_runs";
    }
  | {
      type: "unsubscribe_runs";
    }
  | {
      type: "subscribe_run";
      runId: string;
    }
  | {
      type: "unsubscribe_run";
      runId: string;
    }
  | {
      type: "resync_runs";
    }
  | {
      type: "resync_run";
      runId: string;
    }
  | {
      type: "ping";
    };

export type ReplayServerMessage =
  | {
      type: "ready";
      protocol: ReplayProtocol;
    }
  | {
      type: "pong";
    }
  | {
      type: "runs_snapshot";
      version: number;
      state: ViewerRunsState;
    }
  | {
      type: "runs_patch";
      fromVersion: number;
      toVersion: number;
      ops: ReplayJsonPatchOperation[];
    }
  | {
      type: "run_snapshot";
      runId: string;
      version: number;
      state: ViewerRunLiveState;
    }
  | {
      type: "run_patch";
      runId: string;
      fromVersion: number;
      toVersion: number;
      ops: ReplayJsonPatchOperation[];
    }
  | {
      type: "error";
      code: "protocol_error" | "run_not_found" | "version_mismatch" | "internal_error";
      message: string;
      runId?: string;
    };
