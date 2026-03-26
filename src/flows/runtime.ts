import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createOutputFormatter } from "../output.js";
import { promptToDisplayText, textPrompt } from "../prompt-content.js";
import { resolveSessionRecord } from "../session-persistence.js";
import { TimeoutError, withTimeout } from "../session-runtime-helpers.js";
import {
  cancelSessionPrompt,
  createSession,
  runOnce,
  sendSession,
  type SessionAgentOptions,
} from "../session.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
} from "../types.js";
import { formatShellActionSummary, runShellAction } from "./executors/shell.js";
import { FlowRunStore, flowRunsBaseDir } from "./store.js";

type MaybePromise<T> = T | Promise<T>;
const DEFAULT_FLOW_HEARTBEAT_MS = 5_000;
const DEFAULT_FLOW_STEP_TIMEOUT_MS = 15 * 60_000;

export type FlowNodeContext<TInput = unknown> = {
  input: TInput;
  outputs: Record<string, unknown>;
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

export type FlowStepRecord = {
  nodeId: string;
  kind: FlowNodeDefinition["kind"];
  startedAt: string;
  finishedAt: string;
  promptText: string | null;
  rawText: string | null;
  output: unknown;
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

type MemoryWritable = {
  write(chunk: string): void;
};

type FlowNodeExecutionResult = {
  output: unknown;
  promptText: string | null;
  rawText: string | null;
  sessionInfo: FlowSessionBinding | null;
  agentInfo: ReturnType<FlowRunnerOptions["resolveAgent"]> | null;
};

export type FlowRunnerOptions = {
  resolveAgent: (profile?: string) => {
    agentName: string;
    agentCommand: string;
    cwd: string;
  };
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

export function defineFlow<TFlow extends FlowDefinition>(definition: TFlow): TFlow {
  return definition;
}

export function acp(definition: Omit<AcpNodeDefinition, "kind">): AcpNodeDefinition {
  return {
    kind: "acp",
    ...definition,
  };
}

export function compute(definition: Omit<ComputeNodeDefinition, "kind">): ComputeNodeDefinition {
  return {
    kind: "compute",
    ...definition,
  };
}

export function action(
  definition: Omit<FunctionActionNodeDefinition, "kind">,
): FunctionActionNodeDefinition;
export function action(
  definition: Omit<ShellActionNodeDefinition, "kind">,
): ShellActionNodeDefinition;
export function action(
  definition: Omit<FunctionActionNodeDefinition, "kind"> | Omit<ShellActionNodeDefinition, "kind">,
): ActionNodeDefinition {
  return {
    kind: "action",
    ...definition,
  } as ActionNodeDefinition;
}

export function shell(
  definition: Omit<ShellActionNodeDefinition, "kind">,
): ShellActionNodeDefinition {
  return {
    kind: "action",
    ...definition,
  };
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "kind"> = {},
): CheckpointNodeDefinition {
  return {
    kind: "checkpoint",
    ...definition,
  };
}

export class FlowRunner {
  private readonly resolveAgent;
  private readonly permissionMode;
  private readonly mcpServers?;
  private readonly nonInteractivePermissions?;
  private readonly authCredentials?;
  private readonly authPolicy?;
  private readonly timeoutMs?;
  private readonly defaultNodeTimeoutMs;
  private readonly ttlMs?;
  private readonly verbose?;
  private readonly suppressSdkConsoleErrors?;
  private readonly sessionOptions?;
  private readonly services;
  private readonly store;

  constructor(options: FlowRunnerOptions) {
    this.resolveAgent = options.resolveAgent;
    this.permissionMode = options.permissionMode;
    this.mcpServers = options.mcpServers;
    this.nonInteractivePermissions = options.nonInteractivePermissions;
    this.authCredentials = options.authCredentials;
    this.authPolicy = options.authPolicy;
    this.timeoutMs = options.timeoutMs;
    this.defaultNodeTimeoutMs =
      options.defaultNodeTimeoutMs ?? options.timeoutMs ?? DEFAULT_FLOW_STEP_TIMEOUT_MS;
    this.ttlMs = options.ttlMs;
    this.verbose = options.verbose;
    this.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    this.sessionOptions = options.sessionOptions;
    this.services = options.services ?? {};
    this.store = new FlowRunStore(options.outputRoot ?? flowRunsBaseDir());
  }

  async run(
    flow: FlowDefinition,
    input: unknown,
    options: { flowPath?: string } = {},
  ): Promise<FlowRunResult> {
    validateFlowDefinition(flow);

    const runId = createRunId(flow.name);
    const runDir = await this.store.createRunDir(runId);
    const state: FlowRunState = {
      runId,
      flowName: flow.name,
      flowPath: options.flowPath,
      startedAt: isoNow(),
      updatedAt: isoNow(),
      status: "running",
      input,
      outputs: {},
      steps: [],
      sessionBindings: {},
    };

    await this.store.writeSnapshot(runDir, state, {
      type: "run_started",
      flowName: flow.name,
      flowPath: options.flowPath,
    });

    let current: string | null = flow.startAt;

    try {
      while (current) {
        const node = flow.nodes[current];
        if (!node) {
          throw new Error(`Unknown flow node: ${current}`);
        }

        const startedAt = isoNow();
        const context = this.makeContext(state, input);
        let output: unknown;
        let promptText: string | null = null;
        let rawText: string | null = null;
        let sessionInfo: FlowSessionBinding | null = null;
        let agentInfo: ReturnType<FlowRunnerOptions["resolveAgent"]> | null = null;
        this.markNodeStarted(state, current, node.kind, startedAt, node.statusDetail);
        await this.store.writeSnapshot(runDir, state, {
          type: "node_started",
          nodeId: current,
          kind: node.kind,
        });
        ({ output, promptText, rawText, sessionInfo, agentInfo } = await this.executeNode(
          runDir,
          state,
          flow,
          current,
          node,
          context,
        ));

        if (node.kind === "checkpoint") {
          state.outputs[current] = output;
          state.waitingOn = current;
          state.updatedAt = isoNow();
          state.status = "waiting";
          this.clearActiveNode(state, (output as { summary?: string } | null)?.summary ?? current);
          state.steps.push({
            nodeId: current,
            kind: node.kind,
            startedAt,
            finishedAt: isoNow(),
            promptText,
            rawText,
            output,
            session: null,
            agent: null,
          });
          await this.store.writeSnapshot(runDir, state, {
            type: "checkpoint_entered",
            nodeId: current,
            output,
          });
          return {
            runDir,
            state,
          };
        }

        state.outputs[current] = output;
        state.updatedAt = isoNow();
        this.clearActiveNode(state);
        state.steps.push({
          nodeId: current,
          kind: node.kind,
          startedAt,
          finishedAt: isoNow(),
          promptText,
          rawText,
          output,
          session: sessionInfo,
          agent: agentInfo,
        });

        await this.store.writeSnapshot(runDir, state, {
          type: "node_completed",
          nodeId: current,
          output,
        });

        current = resolveNext(flow.edges, current, output);
      }

      state.status = "completed";
      state.finishedAt = isoNow();
      state.updatedAt = state.finishedAt;
      this.clearActiveNode(state);
      await this.store.writeSnapshot(runDir, state, { type: "run_completed" });
      return {
        runDir,
        state,
      };
    } catch (error) {
      state.status = error instanceof TimeoutError ? "timed_out" : "failed";
      state.updatedAt = isoNow();
      state.finishedAt = state.updatedAt;
      state.error = error instanceof Error ? error.message : String(error);
      state.statusDetail = state.currentNode
        ? `Failed in ${state.currentNode}: ${state.error}`
        : state.error;
      await this.store.writeSnapshot(runDir, state, {
        type: "run_failed",
        error: state.error,
      });
      throw error;
    }
  }

  private makeContext(state: FlowRunState, input: unknown): FlowNodeContext {
    return {
      input,
      outputs: state.outputs,
      state,
      services: this.services,
    };
  }

  private async executeNode(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    nodeId: string,
    node: FlowNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    switch (node.kind) {
      case "compute":
        return await this.executeComputeNode(runDir, state, node, context);
      case "action":
        return await this.executeActionNode(runDir, state, node, context);
      case "checkpoint":
        return await this.executeCheckpointNode(nodeId, node, context);
      case "acp":
        return await this.executeAcpNode(runDir, state, flow, node, context);
      default: {
        const exhaustive: never = node;
        throw new Error(`Unsupported flow node: ${String(exhaustive)}`);
      }
    }
  }

  private async executeComputeNode(
    runDir: string,
    state: FlowRunState,
    node: ComputeNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const output = await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      async () =>
        await withTimeout(
          Promise.resolve(node.run(context)),
          node.timeoutMs ?? this.defaultNodeTimeoutMs,
        ),
    );
    return {
      output,
      promptText: null,
      rawText: null,
      sessionInfo: null,
      agentInfo: null,
    };
  }

  private async executeActionNode(
    runDir: string,
    state: FlowRunState,
    node: ActionNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    if ("run" in node) {
      const output = await this.runWithHeartbeat(
        runDir,
        state,
        state.currentNode ?? "",
        node,
        async () =>
          await withTimeout(
            Promise.resolve(node.run(context)),
            node.timeoutMs ?? this.defaultNodeTimeoutMs,
          ),
      );
      return {
        output,
        promptText: null,
        rawText: null,
        sessionInfo: null,
        agentInfo: null,
      };
    }

    const execution = await Promise.resolve(node.exec(context));
    const effectiveExecution: ShellActionExecution = {
      ...execution,
      timeoutMs: execution.timeoutMs ?? node.timeoutMs ?? this.defaultNodeTimeoutMs,
    };
    this.updateStatusDetail(state, formatShellActionSummary(effectiveExecution));
    await this.store.writeLive(runDir, state, {
      type: "node_detail",
      nodeId: state.currentNode,
      detail: state.statusDetail,
    });
    const result = await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      async () => await runShellAction(effectiveExecution),
    );
    const output = node.parse ? await node.parse(result, context) : result;
    return {
      output,
      promptText: null,
      rawText: result.combinedOutput,
      sessionInfo: null,
      agentInfo: null,
    };
  }

  private async executeCheckpointNode(
    nodeId: string,
    node: CheckpointNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const output =
      typeof node.run === "function"
        ? await node.run(context)
        : {
            checkpoint: nodeId,
            summary: node.summary ?? nodeId,
          };
    return {
      output,
      promptText: null,
      rawText: null,
      sessionInfo: null,
      agentInfo: null,
    };
  }

  private async executeAcpNode(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const resolvedAgent = this.resolveAgent(node.profile);
    const agentInfo = {
      ...resolvedAgent,
      cwd: await resolveNodeCwd(resolvedAgent.cwd, node.cwd, context),
    };
    const prompt = normalizePromptInput(await node.prompt(context));
    const promptText = promptToDisplayText(prompt);
    this.updateStatusDetail(state, summarizePrompt(promptText, node.statusDetail));
    await this.store.writeLive(runDir, state, {
      type: "node_detail",
      nodeId: state.currentNode,
      detail: state.statusDetail,
    });

    if (node.session?.isolated) {
      const rawText = await this.runWithHeartbeat(
        runDir,
        state,
        state.currentNode ?? "",
        node,
        async () =>
          await this.runIsolatedPrompt(
            agentInfo,
            prompt,
            node.timeoutMs ?? this.defaultNodeTimeoutMs,
          ),
      );
      return {
        output: node.parse ? await node.parse(rawText, context) : rawText,
        promptText,
        rawText,
        sessionInfo: null,
        agentInfo,
      };
    }

    const boundSession = await this.ensureSessionBinding(state, flow, node, agentInfo);
    const rawText = await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      async () =>
        await this.runPersistentPrompt(
          boundSession,
          prompt,
          node.timeoutMs ?? this.defaultNodeTimeoutMs,
        ),
      async () => {
        await cancelSessionPrompt({
          sessionId: boundSession.acpxRecordId,
        });
      },
    );
    const sessionInfo = await this.refreshSessionBinding(boundSession);
    state.sessionBindings[sessionInfo.key] = sessionInfo;
    return {
      output: node.parse ? await node.parse(rawText, context) : rawText,
      promptText,
      rawText,
      sessionInfo,
      agentInfo,
    };
  }

  private markNodeStarted(
    state: FlowRunState,
    nodeId: string,
    kind: FlowNodeDefinition["kind"],
    startedAt: string,
    detail?: string,
  ): void {
    state.status = "running";
    state.waitingOn = undefined;
    state.currentNode = nodeId;
    state.currentNodeKind = kind;
    state.currentNodeStartedAt = startedAt;
    state.lastHeartbeatAt = startedAt;
    state.statusDetail = detail ?? `Running ${kind} node ${nodeId}`;
  }

  private clearActiveNode(state: FlowRunState, detail?: string): void {
    state.currentNode = undefined;
    state.currentNodeKind = undefined;
    state.currentNodeStartedAt = undefined;
    state.lastHeartbeatAt = undefined;
    state.statusDetail = detail;
  }

  private updateStatusDetail(state: FlowRunState, detail?: string): void {
    if (!detail) {
      return;
    }
    state.statusDetail = detail;
  }

  private async runWithHeartbeat<T>(
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    node: FlowNodeCommon,
    run: () => Promise<T>,
    onTimeout?: () => Promise<void>,
  ): Promise<T> {
    const heartbeatMs = Math.max(0, Math.round(node.heartbeatMs ?? DEFAULT_FLOW_HEARTBEAT_MS));
    let timer: NodeJS.Timeout | undefined;
    let active = true;
    const heartbeat = async (): Promise<void> => {
      if (!active) {
        return;
      }
      state.lastHeartbeatAt = isoNow();
      state.updatedAt = state.lastHeartbeatAt;
      await this.store.writeLive(runDir, state, {
        type: "node_heartbeat",
        nodeId,
      });
    };

    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        void heartbeat();
      }, heartbeatMs);
    }

    try {
      return await run();
    } catch (error) {
      if (error instanceof TimeoutError && onTimeout) {
        await onTimeout().catch(() => {
          // best effort cancellation only
        });
      }
      throw error;
    } finally {
      active = false;
      if (timer) {
        clearInterval(timer);
      }
    }
  }

  private async ensureSessionBinding(
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    agent: ReturnType<FlowRunnerOptions["resolveAgent"]>,
  ): Promise<FlowSessionBinding> {
    const handle = node.session?.handle ?? "main";
    const key = createSessionBindingKey(agent.agentCommand, agent.cwd, handle);
    const existing = state.sessionBindings[key];
    if (existing) {
      return existing;
    }

    const name = createSessionName(flow.name, handle, agent.cwd, state.runId);
    const created = await createSession({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      name,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      timeoutMs: this.defaultNodeTimeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });

    const binding: FlowSessionBinding = {
      key,
      handle,
      name,
      profile: node.profile,
      agentName: agent.agentName,
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      acpxRecordId: created.acpxRecordId,
      acpSessionId: created.acpSessionId,
      agentSessionId: created.agentSessionId,
    };
    state.sessionBindings[key] = binding;
    return binding;
  }

  private async refreshSessionBinding(binding: FlowSessionBinding): Promise<FlowSessionBinding> {
    const record = await resolveSessionRecord(binding.acpxRecordId);
    return {
      ...binding,
      acpSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    };
  }

  private async runPersistentPrompt(
    binding: FlowSessionBinding,
    prompt: PromptInput,
    timeoutMs?: number,
  ): Promise<string> {
    const capture = createQuietCaptureOutput();
    await sendSession({
      sessionId: binding.acpxRecordId,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      outputFormatter: capture.formatter,
      suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
      timeoutMs,
      ttlMs: this.ttlMs,
      verbose: this.verbose,
      waitForCompletion: true,
    });
    return capture.read();
  }

  private async runIsolatedPrompt(
    agent: ReturnType<FlowRunnerOptions["resolveAgent"]>,
    prompt: PromptInput,
    timeoutMs?: number,
  ): Promise<string> {
    const capture = createQuietCaptureOutput();
    await runOnce({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      outputFormatter: capture.formatter,
      suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
      timeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });
    return capture.read();
  }
}

function validateFlowDefinition(flow: FlowDefinition): void {
  if (!flow.name.trim()) {
    throw new Error("Flow name must not be empty");
  }
  if (!flow.nodes[flow.startAt]) {
    throw new Error(`Flow start node is missing: ${flow.startAt}`);
  }

  const outgoingEdges = new Set<string>();
  for (const edge of flow.edges) {
    if (!flow.nodes[edge.from]) {
      throw new Error(`Flow edge references unknown from-node: ${edge.from}`);
    }
    if (outgoingEdges.has(edge.from)) {
      throw new Error(`Flow node must not declare multiple outgoing edges: ${edge.from}`);
    }
    outgoingEdges.add(edge.from);
    if ("to" in edge) {
      if (!flow.nodes[edge.to]) {
        throw new Error(`Flow edge references unknown to-node: ${edge.to}`);
      }
      continue;
    }
    for (const target of Object.values(edge.switch.cases)) {
      if (!flow.nodes[target]) {
        throw new Error(`Flow switch references unknown to-node: ${target}`);
      }
    }
  }
}

function normalizePromptInput(prompt: PromptInput | string): PromptInput {
  return typeof prompt === "string" ? textPrompt(prompt) : prompt;
}

async function resolveNodeCwd(
  defaultCwd: string,
  cwd: string | ((context: FlowNodeContext) => MaybePromise<string | undefined>) | undefined,
  context: FlowNodeContext,
): Promise<string> {
  if (typeof cwd === "function") {
    const resolved = (await cwd(context)) ?? defaultCwd;
    return path.resolve(defaultCwd, resolved);
  }
  return path.resolve(defaultCwd, cwd ?? defaultCwd);
}

function resolveNext(edges: FlowEdge[], from: string, output: unknown): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge) {
    return null;
  }

  if ("to" in edge) {
    return edge.to;
  }

  const value = getByPath(output, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
}

function getByPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new Error(`Unsupported JSON path: ${jsonPath}`);
  }

  return jsonPath
    .slice(2)
    .split(".")
    .reduce<unknown>((current, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}

function summarizePrompt(promptText: string, explicitDetail?: string): string {
  if (explicitDetail) {
    return explicitDetail;
  }

  const line = promptText
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (!line) {
    return "Running ACP prompt";
  }

  const truncated = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return `ACP: ${truncated}`;
}

function createQuietCaptureOutput(): {
  formatter: ReturnType<typeof createOutputFormatter>;
  read: () => string;
} {
  const chunks: string[] = [];
  const stdout: MemoryWritable = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };

  return {
    formatter: createOutputFormatter("quiet", {
      stdout,
    }),
    read: () => chunks.join("").trim(),
  };
}

function createRunId(flowName: string): string {
  const stamp = isoNow().replaceAll(":", "").replaceAll(".", "");
  const slug = flowName
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

function createSessionBindingKey(agentCommand: string, cwd: string, handle: string): string {
  return `${agentCommand}::${cwd}::${handle}`;
}

function createSessionName(flowName: string, handle: string, cwd: string, runId: string): string {
  const stamp = stableShortHash(cwd);
  return `${flowName}-${handle}-${stamp}-${runId.slice(-8)}`;
}

function stableShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function isoNow(): string {
  return new Date().toISOString();
}
