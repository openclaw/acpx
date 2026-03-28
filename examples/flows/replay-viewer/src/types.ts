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
  protocolVersion?: number;
  closed?: boolean;
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
