import type { SessionAgentOptions } from "../session/session.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
  SessionRecord,
} from "../types.js";

type MaybePromise<T> = T | Promise<T>;

export type FlowRunDefinition<TInput = unknown> = {
  title?:
    | string
    | ((context: {
        input: TInput;
        flowName: string;
        flowPath?: string;
      }) => MaybePromise<string | undefined>);
};

export type FlowNodeContext<TInput = unknown> = {
  input: TInput;
  outputs: Record<string, unknown>;
  results: Record<string, FlowNodeResult>;
  state: FlowRunState;
  services: Record<string, unknown>;
};

export type FlowNodeCommon = {
  timeoutMs?: number;
  heartbeatMs?: number;
  statusDetail?: string;
};

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

export type AcpNodeDefinition = FlowNodeCommon & {
  nodeType: "acp";
  profile?: string;
  cwd?: string | ((context: FlowNodeContext) => MaybePromise<string | undefined>);
  session?: {
    handle?: string;
    isolated?: boolean;
  };
  prompt: (context: FlowNodeContext) => MaybePromise<PromptInput | string>;
  parse?: (text: string, context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ComputeNodeDefinition = FlowNodeCommon & {
  nodeType: "compute";
  run: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type FunctionActionNodeDefinition = FlowNodeCommon & {
  nodeType: "action";
  run: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ShellActionExecution = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  shell?: boolean | string;
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
};

export type ShellActionResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

export type ShellActionNodeDefinition = FlowNodeCommon & {
  nodeType: "action";
  exec: (context: FlowNodeContext) => MaybePromise<ShellActionExecution>;
  parse?: (result: ShellActionResult, context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ActionNodeDefinition = FunctionActionNodeDefinition | ShellActionNodeDefinition;

export type CheckpointNodeDefinition = FlowNodeCommon & {
  nodeType: "checkpoint";
  summary?: string;
  run?: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type FlowNodeDefinition =
  | AcpNodeDefinition
  | ComputeNodeDefinition
  | ActionNodeDefinition
  | CheckpointNodeDefinition;

export type FlowPermissionRequirements = {
  requiredMode: PermissionMode;
  requireExplicitGrant?: boolean;
  reason?: string;
};

export type FlowDefinition = {
  name: string;
  run?: FlowRunDefinition;
  permissions?: FlowPermissionRequirements;
  startAt: string;
  nodes: Record<string, FlowNodeDefinition>;
  edges: FlowEdge[];
};

export type FlowNodeSnapshot = FlowNodeCommon & {
  nodeType: FlowNodeDefinition["nodeType"];
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
};

export type FlowDefinitionSnapshot = {
  schema: "acpx.flow-definition-snapshot.v1";
  name: string;
  run?: {
    hasTitle?: boolean;
  };
  permissions?: FlowPermissionRequirements;
  startAt: string;
  nodes: Record<string, FlowNodeSnapshot>;
  edges: FlowEdge[];
};

export type FlowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

export type FlowNodeResult = {
  attemptId: string;
  nodeId: string;
  nodeType: FlowNodeDefinition["nodeType"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
};

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
  signal?: NodeJS.Signals | null;
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

export type FlowStepRecord = {
  attemptId: string;
  nodeId: string;
  nodeType: FlowNodeDefinition["nodeType"];
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
  currentNodeType?: FlowNodeDefinition["nodeType"];
  currentNodeStartedAt?: string;
  lastHeartbeatAt?: string;
  statusDetail?: string;
  waitingOn?: string;
  error?: string;
};

export type FlowRunResult = {
  runDir: string;
  state: FlowRunState;
};

export type FlowManifestSessionEntry = {
  id: string;
  handle: string;
  bindingPath: string;
  recordPath: string;
  eventsPath: string;
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
  sessions: FlowManifestSessionEntry[];
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

export type FlowTraceEventDraft = Omit<FlowTraceEvent, "seq" | "at" | "runId">;

export type FlowBundledSessionEvent = {
  seq: number;
  at: string;
  direction: AcpMessageDirection;
  message: AcpJsonRpcMessage;
};

export type FlowSessionBundleSnapshot = {
  binding: FlowSessionBinding;
  record: SessionRecord;
};

export type ResolvedFlowAgent = {
  agentName: string;
  agentCommand: string;
  cwd: string;
};

export type FlowRunnerOptions = {
  resolveAgent: (profile?: string) => ResolvedFlowAgent;
  permissionMode: PermissionMode;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  defaultNodeTimeoutMs?: number;
  ttlMs?: number;
  verbose?: boolean;
  suppressSdkConsoleErrors?: boolean;
  sessionOptions?: SessionAgentOptions;
  services?: Record<string, unknown>;
  outputRoot?: string;
};
