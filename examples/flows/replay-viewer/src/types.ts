export type FlowEdge =
  | {
      from: string;
      to: string;
    }
  | {
      from: string;
      switch: {
        on: string;
        cases: Record<string, string>;
      };
    };

export type FlowDefinitionSnapshot = {
  schema: "acpx.flow-definition-snapshot.v1";
  name: string;
  run?: {
    hasTitle?: boolean;
  };
  startAt: string;
  nodes: Record<
    string,
    {
      nodeType: "acp" | "compute" | "action" | "checkpoint";
      profile?: string;
      session?: {
        handle?: string;
        isolated?: boolean;
      };
      cwd?: {
        mode: "default" | "static" | "dynamic";
        value?: string;
      };
      summary?: string;
      actionExecution?: "function" | "shell";
      hasPrompt?: boolean;
      hasParse?: boolean;
      hasRun?: boolean;
      hasExec?: boolean;
    }
  >;
  edges: FlowEdge[];
};

export type FlowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

export type FlowArtifactRef = {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
};

export type FlowConversationTrace = {
  sessionId: string;
  messageStart: number;
  messageEnd: number;
  eventStartSeq: number;
  eventEndSeq: number;
};

export type FlowActionReceipt = {
  actionType: "shell" | "function";
  command?: string;
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
};

export type FlowStepTrace = {
  sessionId?: string;
  promptArtifact?: FlowArtifactRef;
  rawResponseArtifact?: FlowArtifactRef;
  outputArtifact?: FlowArtifactRef;
  outputInline?: unknown;
  stdoutArtifact?: FlowArtifactRef;
  stderrArtifact?: FlowArtifactRef;
  conversation?: FlowConversationTrace;
  action?: FlowActionReceipt;
};

export type FlowSessionBinding = {
  key: string;
  handle: string;
  bundleId: string;
  name: string;
  profile?: string;
  agentName: string;
  agentCommand: string;
  cwd: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
};

export type FlowStepRecord = {
  attemptId: string;
  nodeId: string;
  nodeType: "acp" | "compute" | "action" | "checkpoint";
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  promptText: string | null;
  rawText: string | null;
  output: unknown;
  error?: string;
  session: FlowSessionBinding | null;
  agent: {
    agentName: string;
    agentCommand: string;
    cwd: string;
  } | null;
  trace?: FlowStepTrace;
};

export type FlowNodeResult = {
  attemptId: string;
  nodeId: string;
  nodeType: FlowStepRecord["nodeType"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
};

export type FlowRunState = {
  runId: string;
  flowName: string;
  runTitle?: string;
  flowPath?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: "running" | "waiting" | "completed" | "failed" | "timed_out";
  input: unknown;
  outputs: Record<string, unknown>;
  results: Record<string, FlowNodeResult>;
  steps: FlowStepRecord[];
  sessionBindings: Record<string, FlowSessionBinding>;
  currentNode?: string;
  currentAttemptId?: string;
  currentNodeType?: FlowStepRecord["nodeType"];
  currentNodeStartedAt?: string;
  lastHeartbeatAt?: string;
  statusDetail?: string;
  waitingOn?: string;
  error?: string;
};

export type FlowRunManifest = {
  schema: "acpx.flow-run-bundle.v1";
  runId: string;
  flowName: string;
  runTitle?: string;
  flowPath?: string;
  startedAt: string;
  finishedAt?: string;
  status: FlowRunState["status"];
  traceSchema: "acpx.flow-trace-event.v1";
  paths: {
    flow: string;
    trace: string;
    runProjection: string;
    liveProjection: string;
    stepsProjection: string;
    sessionsDir: string;
    artifactsDir: string;
  };
  sessions: Array<{
    id: string;
    handle: string;
    bindingPath: string;
    recordPath: string;
    eventsPath: string;
  }>;
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

export type FlowTraceEvent = {
  seq: number;
  at: string;
  scope: "run" | "node" | "acp" | "action" | "session" | "artifact";
  type: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  artifact?: FlowArtifactRef;
  payload: Record<string, unknown>;
};

export type FlowBundledSessionEvent = {
  seq: number;
  at: string;
  direction: "inbound" | "outbound";
  message: Record<string, unknown>;
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
  };
  request_token_usage?: Record<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  >;
  acpx?: {
    current_mode_id?: string;
    desired_mode_id?: string;
    current_model_id?: string;
    available_models?: string[];
    available_commands?: string[];
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
