import type { SessionAgentOptions } from "../session.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
} from "../types.js";

type MaybePromise<T> = T | Promise<T>;

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
  kind: "acp";
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
  kind: "compute";
  run: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type FunctionActionNodeDefinition = FlowNodeCommon & {
  kind: "action";
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
  kind: "action";
  exec: (context: FlowNodeContext) => MaybePromise<ShellActionExecution>;
  parse?: (result: ShellActionResult, context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ActionNodeDefinition = FunctionActionNodeDefinition | ShellActionNodeDefinition;

export type CheckpointNodeDefinition = FlowNodeCommon & {
  kind: "checkpoint";
  summary?: string;
  run?: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type FlowNodeDefinition =
  | AcpNodeDefinition
  | ComputeNodeDefinition
  | ActionNodeDefinition
  | CheckpointNodeDefinition;

export type FlowDefinition = {
  name: string;
  startAt: string;
  nodes: Record<string, FlowNodeDefinition>;
  edges: FlowEdge[];
};

export type FlowNodeOutcome = "ok" | "timed_out" | "failed" | "cancelled";

export type FlowNodeResult = {
  nodeId: string;
  kind: FlowNodeDefinition["kind"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
};

export type FlowStepRecord = {
  nodeId: string;
  kind: FlowNodeDefinition["kind"];
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
};

export type FlowSessionBinding = {
  key: string;
  handle: string;
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
  currentNodeKind?: FlowNodeDefinition["kind"];
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
