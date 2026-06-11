import { randomUUID } from "node:crypto";
import type { AcpClient } from "../acp/client.js";
import { InterruptedError, TimeoutError, withInterrupt, withTimeout } from "../async-control.js";
import { promptToDisplayText } from "../prompt-content.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
} from "../session/conversation-model.js";
import { resolveSessionRecord } from "../session/persistence.js";
import {
  cancelSessionPrompt,
  createSessionWithClient,
  runOnce,
  sendSessionDirect,
} from "../session/session.js";
import type { PermissionPolicy, PromptInput, SessionRecord } from "../types.js";
import { acp, action, checkpoint, compute, defineFlow, shell } from "./definition.js";
import { formatShellActionSummary, runShellAction } from "./executors/shell.js";
import { resolveNext, resolveNextForOutcome, validateFlowDefinition } from "./graph.js";
import {
  attachStepTrace,
  clearActiveNode,
  createIsolatedSessionBinding,
  createNodeOutcomePayload,
  createNodeResult,
  createQuietCaptureOutput,
  createRunId,
  createSessionBindingKey,
  createSessionBundleId,
  createSessionName,
  createSyntheticSessionRecord,
  extractAttachedStepTrace,
  finalizeStepTrace,
  findConversationDeltaStart,
  isoNow,
  makeFlowNodeContext,
  markNodeStarted,
  nextAttemptId,
  normalizePromptInput,
  outcomeForError,
  persistRunFailure,
  resolveFlowRunTitle,
  resolveNodeCwd,
  resolveShellActionCwd,
  summarizePrompt,
  updateStatusDetail,
} from "./runtime-support.js";
import { FlowRunStore } from "./store.js";
import type {
  AcpNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FlowDefinition,
  FlowNodeCommon,
  FlowNodeContext,
  FlowNodeDefinition,
  FlowStepTrace,
  FlowArtifactRef,
  FlowRunResult,
  FlowRunState,
  FlowRunnerOptions,
  FlowSessionBinding,
  FlowNodeResult,
  ResolvedFlowAgent,
  ShellActionExecution,
} from "./types.js";

export { acp, action, checkpoint, compute, defineFlow, shell };
export type {
  AcpNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FlowDefinition,
  FlowEdge,
  FlowNodeCommon,
  FlowNodeContext,
  FlowNodeDefinition,
  FlowPermissionRequirements,
  FlowNodeOutcome,
  FlowNodeResult,
  FlowRunResult,
  FlowRunState,
  FlowRunnerOptions,
  FlowSessionBinding,
  FlowStepRecord,
  FunctionActionNodeDefinition,
  ResolvedFlowAgent,
  ShellActionExecution,
  ShellActionNodeDefinition,
  ShellActionResult,
} from "./types.js";

const DEFAULT_FLOW_HEARTBEAT_MS = 5_000;
const DEFAULT_FLOW_STEP_TIMEOUT_MS = 15 * 60_000;

type FlowNodeExecutionResult = {
  output: unknown;
  promptText: string | null;
  rawText: string | null;
  sessionInfo: FlowSessionBinding | null;
  agentInfo: ResolvedFlowAgent | null;
  trace: FlowStepTrace | null;
};

type FlowRunExecutionResult = {
  runDir: string;
  state: FlowRunState;
};

type FlowStepExecutionResult = FlowNodeExecutionResult & {
  attemptId: string;
  nodeResult: FlowNodeResult;
  nodeId: string;
  node: FlowNodeDefinition;
  startedAt: string;
  state: FlowRunState;
  executionError?: unknown;
};

type TracedPromptResult = {
  rawText: string;
  sessionInfo: FlowSessionBinding;
  conversation: {
    sessionId: string;
    messageStart: number;
    messageEnd: number;
    eventStartSeq: number;
    eventEndSeq: number;
  };
};

type PreparedAcpPrompt = {
  agentInfo: ResolvedFlowAgent;
  prompt: PromptInput;
  promptText: string;
  promptArtifact: FlowArtifactRef;
  nodeTimeoutMs: number | undefined;
};

export class FlowRunner {
  private readonly resolveAgent;
  private readonly defaultCwd;
  private readonly permissionMode;
  private readonly mcpServers?;
  private readonly nonInteractivePermissions?;
  private readonly permissionPolicy?: PermissionPolicy;
  private readonly authCredentials?;
  private readonly authPolicy?;
  private readonly timeoutMs?;
  private readonly defaultNodeTimeoutMs;
  private readonly verbose?;
  private readonly suppressSdkConsoleErrors?;
  private readonly sessionOptions?;
  private readonly services;
  private readonly store;
  private readonly pendingPersistentSessionClients = new Map<string, AcpClient>();

  constructor(options: FlowRunnerOptions) {
    this.resolveAgent = options.resolveAgent;
    this.defaultCwd = options.resolveAgent(undefined).cwd;
    this.permissionMode = options.permissionMode;
    this.mcpServers = options.mcpServers;
    this.nonInteractivePermissions = options.nonInteractivePermissions;
    this.permissionPolicy = options.permissionPolicy;
    this.authCredentials = options.authCredentials;
    this.authPolicy = options.authPolicy;
    this.timeoutMs = options.timeoutMs;
    this.defaultNodeTimeoutMs =
      options.defaultNodeTimeoutMs ?? options.timeoutMs ?? DEFAULT_FLOW_STEP_TIMEOUT_MS;
    this.verbose = options.verbose;
    this.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    this.sessionOptions = options.sessionOptions;
    this.services = options.services ?? {};
    this.store = new FlowRunStore(options.outputRoot);
  }

  async run(
    flow: FlowDefinition,
    input: unknown,
    options: { flowPath?: string } = {},
  ): Promise<FlowRunResult> {
    validateFlowDefinition(flow);

    const runId = createRunId(flow.name);
    const runTitle = await resolveFlowRunTitle(flow, input, options.flowPath);
    const runDir = await this.store.createRunDir(runId);
    const state: FlowRunState = {
      runId,
      flowName: flow.name,
      runTitle,
      flowPath: options.flowPath,
      startedAt: isoNow(),
      updatedAt: isoNow(),
      status: "running",
      input,
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
    };
    const inputArtifact = await this.store.writeArtifact(runDir, state, input, {
      mediaType: "application/json",
      extension: "json",
      emitTrace: false,
    });
    await this.store.initializeRunBundle(runDir, {
      flow,
      state,
      inputArtifact,
    });

    try {
      return await withInterrupt(
        async () => await this.executeFlowRun(flow, input, runDir, state),
        async () => {
          await persistRunFailure(this.store, runDir, state, new InterruptedError());
        },
      );
    } finally {
      await this.closePendingPersistentSessionClients();
    }
  }

  private async executeFlowRun(
    flow: FlowDefinition,
    input: unknown,
    runDir: string,
    state: FlowRunState,
  ): Promise<FlowRunExecutionResult> {
    let current: string | null = flow.startAt;
    const attemptCounts = new Map<string, number>();
    try {
      while (current) {
        const step = await this.executeFlowStep(flow, input, runDir, state, current, attemptCounts);
        const waiting = await this.maybeCompleteCheckpointStep(runDir, state, step);
        if (waiting) {
          return waiting;
        }
        await this.recordFlowStepOutcome(runDir, state, step);
        current = this.resolveNextNode(flow, step);
      }
      return await this.completeFlowRun(runDir, state);
    } catch (error) {
      await persistRunFailure(this.store, runDir, state, error);
      throw error;
    }
  }

  private async executeFlowStep(
    flow: FlowDefinition,
    input: unknown,
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    attemptCounts: Map<string, number>,
  ): Promise<FlowStepExecutionResult> {
    const node = flow.nodes[nodeId];
    if (!node) {
      throw new Error(`Unknown flow node: ${nodeId}`);
    }
    const attemptId = nextAttemptId(attemptCounts, nodeId);
    const startedAt = isoNow();
    markNodeStarted(state, nodeId, attemptId, node.nodeType, startedAt, node.statusDetail);
    await this.writeNodeStartedSnapshot(runDir, state, nodeId, attemptId, node);
    return await this.executeStartedFlowStep({
      flow,
      input,
      runDir,
      state,
      nodeId,
      node,
      attemptId,
      startedAt,
    });
  }

  private async writeNodeStartedSnapshot(
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    attemptId: string,
    node: FlowNodeDefinition,
  ): Promise<void> {
    await this.store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_started",
      nodeId,
      attemptId,
      payload: {
        nodeType: node.nodeType,
        ...(node.timeoutMs !== undefined
          ? { timeoutMs: node.timeoutMs ?? this.defaultNodeTimeoutMs }
          : { timeoutMs: this.defaultNodeTimeoutMs }),
        ...(state.statusDetail ? { statusDetail: state.statusDetail } : {}),
      },
    });
  }

  private async executeStartedFlowStep(params: {
    flow: FlowDefinition;
    input: unknown;
    runDir: string;
    state: FlowRunState;
    nodeId: string;
    node: FlowNodeDefinition;
    attemptId: string;
    startedAt: string;
  }): Promise<FlowStepExecutionResult> {
    const context = makeFlowNodeContext(params.state, params.input, this.services);
    try {
      const executed = await this.executeNode(
        params.runDir,
        params.state,
        params.flow,
        params.nodeId,
        params.node,
        context,
      );
      return await this.createSuccessfulFlowStep(params, executed);
    } catch (error) {
      return await this.createFailedFlowStep(params, error);
    }
  }

  private async createSuccessfulFlowStep(
    params: {
      runDir: string;
      state: FlowRunState;
      nodeId: string;
      node: FlowNodeDefinition;
      attemptId: string;
      startedAt: string;
    },
    executed: FlowNodeExecutionResult,
  ): Promise<FlowStepExecutionResult> {
    const trace = await finalizeStepTrace(
      this.store,
      params.runDir,
      params.state,
      params.nodeId,
      params.attemptId,
      executed.output,
      executed.trace,
    );
    const nodeResult = createNodeResult({
      attemptId: params.attemptId,
      nodeId: params.nodeId,
      nodeType: params.node.nodeType,
      outcome: "ok",
      startedAt: params.startedAt,
      finishedAt: isoNow(),
      output: executed.output,
    });
    params.state.results[params.nodeId] = nodeResult;
    return {
      ...executed,
      trace,
      nodeResult,
      attemptId: params.attemptId,
      nodeId: params.nodeId,
      node: params.node,
      startedAt: params.startedAt,
      state: params.state,
    };
  }

  private async createFailedFlowStep(
    params: {
      runDir: string;
      state: FlowRunState;
      nodeId: string;
      node: FlowNodeDefinition;
      attemptId: string;
      startedAt: string;
    },
    error: unknown,
  ): Promise<FlowStepExecutionResult> {
    const trace = await finalizeStepTrace(
      this.store,
      params.runDir,
      params.state,
      params.nodeId,
      params.attemptId,
      undefined,
      extractAttachedStepTrace(error) ?? null,
    );
    const nodeResult = createNodeResult({
      attemptId: params.attemptId,
      nodeId: params.nodeId,
      nodeType: params.node.nodeType,
      outcome: outcomeForError(error),
      startedAt: params.startedAt,
      finishedAt: isoNow(),
      error: error instanceof Error ? error.message : String(error),
    });
    params.state.results[params.nodeId] = nodeResult;
    return {
      output: undefined,
      promptText: null,
      rawText: null,
      sessionInfo: null,
      agentInfo: null,
      trace,
      nodeResult,
      executionError: error,
      attemptId: params.attemptId,
      nodeId: params.nodeId,
      node: params.node,
      startedAt: params.startedAt,
      state: params.state,
    };
  }

  private async maybeCompleteCheckpointStep(
    runDir: string,
    state: FlowRunState,
    step: FlowStepExecutionResult,
  ): Promise<FlowRunExecutionResult | undefined> {
    if (step.nodeResult.outcome !== "ok" || step.node.nodeType !== "checkpoint") {
      return undefined;
    }
    state.outputs[step.nodeId] = step.output;
    state.waitingOn = step.nodeId;
    state.updatedAt = isoNow();
    state.status = "waiting";
    await this.recordFlowStepOutcome(runDir, state, step, {
      sessionInfo: null,
      agentInfo: null,
      statusDetail: (step.output as { summary?: string } | null)?.summary ?? step.nodeId,
    });
    return { runDir, state };
  }

  private resolveNextNode(flow: FlowDefinition, step: FlowStepExecutionResult): string | null {
    if (step.nodeResult.outcome === "ok") {
      step.state.outputs[step.nodeId] = step.output;
      return resolveNext(flow.edges, step.nodeId, step.output, step.nodeResult);
    }
    const next = resolveNextForOutcome(flow.edges, step.nodeId, step.nodeResult);
    if (next) {
      return next;
    }
    throw step.executionError;
  }

  private async completeFlowRun(
    runDir: string,
    state: FlowRunState,
  ): Promise<FlowRunExecutionResult> {
    state.status = "completed";
    state.finishedAt = isoNow();
    state.updatedAt = state.finishedAt;
    clearActiveNode(state);
    await this.store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_completed",
      payload: {
        status: state.status,
      },
    });
    return { runDir, state };
  }

  private async recordFlowStepOutcome(
    runDir: string,
    state: FlowRunState,
    step: FlowStepExecutionResult,
    overrides: {
      sessionInfo?: FlowSessionBinding | null;
      agentInfo?: ResolvedFlowAgent | null;
      statusDetail?: string;
    } = {},
  ): Promise<void> {
    state.updatedAt = isoNow();
    clearActiveNode(state, overrides.statusDetail);
    state.steps.push({
      attemptId: step.attemptId,
      nodeId: step.nodeId,
      nodeType: step.node.nodeType,
      outcome: step.nodeResult.outcome,
      startedAt: step.startedAt,
      finishedAt: step.nodeResult.finishedAt,
      promptText: step.promptText,
      rawText: step.rawText,
      output: step.output,
      error: step.nodeResult.error,
      session: overrides.sessionInfo ?? step.sessionInfo,
      agent: overrides.agentInfo ?? step.agentInfo,
      ...(step.trace ? { trace: step.trace } : {}),
    });
    await this.store.writeSnapshot(runDir, state, {
      scope: "node",
      type: "node_outcome",
      nodeId: step.nodeId,
      attemptId: step.attemptId,
      payload: createNodeOutcomePayload(step.nodeResult, step.trace),
    });
  }

  private async executeNode(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    nodeId: string,
    node: FlowNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    switch (node.nodeType) {
      case "compute":
        return await this.executeComputeNode(runDir, state, node, context);
      case "action":
        return await this.executeActionNode(runDir, state, node, context);
      case "checkpoint":
        return await this.executeCheckpointNode(runDir, state, nodeId, node, context);
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
    const nodeTimeoutMs = node.timeoutMs ?? this.defaultNodeTimeoutMs;
    const output = await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      nodeTimeoutMs,
      async () => await Promise.resolve(node.run(context)),
    );
    return {
      output,
      promptText: null,
      rawText: null,
      sessionInfo: null,
      agentInfo: null,
      trace: null,
    };
  }

  private async executeActionNode(
    runDir: string,
    state: FlowRunState,
    node: ActionNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const nodeTimeoutMs = node.timeoutMs ?? this.defaultNodeTimeoutMs;
    if ("run" in node) {
      const output = await this.runWithHeartbeat(
        runDir,
        state,
        state.currentNode ?? "",
        node,
        nodeTimeoutMs,
        async () => await Promise.resolve(node.run(context)),
      );
      return {
        output,
        promptText: null,
        rawText: null,
        sessionInfo: null,
        agentInfo: null,
        trace: {
          action: {
            actionType: "function",
          },
        },
      };
    }

    const { output, rawText, trace } = await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      nodeTimeoutMs,
      async () => {
        const execution = await Promise.resolve(node.exec(context));
        const effectiveExecution: ShellActionExecution = {
          ...execution,
          cwd: resolveShellActionCwd(this.defaultCwd, execution.cwd),
          timeoutMs: execution.timeoutMs ?? nodeTimeoutMs,
        };
        updateStatusDetail(state, formatShellActionSummary(effectiveExecution));
        await this.store.writeLive(runDir, state, {
          scope: "node",
          type: "node_heartbeat",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          payload: {
            statusDetail: state.statusDetail,
          },
        });
        await this.store.appendTrace(runDir, state, {
          scope: "action",
          type: "action_prepared",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          payload: {
            action: {
              actionType: "shell",
              command: effectiveExecution.command,
              args: effectiveExecution.args ?? [],
              cwd: effectiveExecution.cwd,
            },
          },
        });
        const result = await runShellAction(effectiveExecution);
        const stdoutArtifact = await this.store.writeArtifact(runDir, state, result.stdout, {
          mediaType: "text/plain",
          extension: "txt",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
        });
        const stderrArtifact = await this.store.writeArtifact(runDir, state, result.stderr, {
          mediaType: "text/plain",
          extension: "txt",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
        });
        await this.store.appendTrace(runDir, state, {
          scope: "action",
          type: "action_completed",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          payload: {
            action: {
              actionType: "shell",
              command: result.command,
              args: result.args,
              cwd: result.cwd,
              exitCode: result.exitCode,
              signal: result.signal,
              durationMs: result.durationMs,
            },
            stdoutArtifact,
            stderrArtifact,
          },
        });
        const trace: FlowStepTrace = {
          action: {
            actionType: "shell",
            command: result.command,
            args: result.args,
            cwd: result.cwd,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
          },
          stdoutArtifact,
          stderrArtifact,
        };
        let parsedOutput: unknown;
        try {
          parsedOutput = node.parse ? await node.parse(result, context) : result;
        } catch (error) {
          throw attachStepTrace(error, trace);
        }
        return {
          output: parsedOutput,
          rawText: result.combinedOutput,
          trace,
        };
      },
    );
    return {
      output,
      promptText: null,
      rawText,
      sessionInfo: null,
      agentInfo: null,
      trace,
    };
  }

  private async executeCheckpointNode(
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    node: CheckpointNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const nodeTimeoutMs = node.timeoutMs ?? this.defaultNodeTimeoutMs;
    const output =
      typeof node.run === "function"
        ? await this.runWithHeartbeat(
            runDir,
            state,
            state.currentNode ?? "",
            node,
            nodeTimeoutMs,
            async () => await Promise.resolve(node.run?.(context)),
          )
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
      trace: null,
    };
  }

  private async executeAcpNode(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
  ): Promise<FlowNodeExecutionResult> {
    const nodeTimeoutMs = node.timeoutMs ?? this.defaultNodeTimeoutMs;
    let boundSession: FlowSessionBinding | null = null;
    return await this.runWithHeartbeat(
      runDir,
      state,
      state.currentNode ?? "",
      node,
      nodeTimeoutMs,
      async () => {
        const prepared = await this.prepareAcpPrompt(runDir, state, node, context, nodeTimeoutMs);
        if (node.session?.isolated) {
          return await this.executeIsolatedAcpPrompt(runDir, state, flow, node, context, prepared);
        }

        boundSession = await this.ensureSessionBinding(
          runDir,
          state,
          flow,
          node,
          prepared.agentInfo,
          nodeTimeoutMs,
        );
        return await this.executePersistentAcpPrompt(
          runDir,
          state,
          node,
          context,
          prepared,
          boundSession,
        );
      },
      async () => {
        if (!boundSession) {
          return;
        }
        await cancelSessionPrompt({
          sessionId: boundSession.acpxRecordId,
        });
      },
    );
  }

  private async prepareAcpPrompt(
    runDir: string,
    state: FlowRunState,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
    nodeTimeoutMs: number | undefined,
  ): Promise<PreparedAcpPrompt> {
    const resolvedAgent = this.resolveAgent(node.profile);
    const agentInfo = {
      ...resolvedAgent,
      cwd: await resolveNodeCwd(resolvedAgent.cwd, node.cwd, context),
    };
    const prompt = normalizePromptInput(await Promise.resolve(node.prompt(context)));
    const promptText = promptToDisplayText(prompt);
    updateStatusDetail(state, summarizePrompt(promptText, node.statusDetail));
    await this.writeAcpPromptHeartbeat(runDir, state);
    const promptArtifact = await this.store.writeArtifact(runDir, state, promptText, {
      mediaType: "text/plain",
      extension: "txt",
      nodeId: state.currentNode,
      attemptId: state.currentAttemptId,
    });
    return { agentInfo, prompt, promptText, promptArtifact, nodeTimeoutMs };
  }

  private async writeAcpPromptHeartbeat(runDir: string, state: FlowRunState): Promise<void> {
    await this.store.writeLive(runDir, state, {
      scope: "node",
      type: "node_heartbeat",
      nodeId: state.currentNode,
      attemptId: state.currentAttemptId,
      payload: {
        statusDetail: state.statusDetail,
      },
    });
  }

  private async executeIsolatedAcpPrompt(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
    prepared: PreparedAcpPrompt,
  ): Promise<FlowNodeExecutionResult> {
    const binding = createIsolatedSessionBinding(
      flow.name,
      state.runId,
      state.currentAttemptId ?? randomUUID(),
      node.profile,
      prepared.agentInfo,
    );
    await this.initializeIsolatedSessionBundle(runDir, state, binding);
    await this.appendAcpPromptPreparedTrace(runDir, state, binding, prepared.promptArtifact);
    const prompt = await this.runIsolatedPrompt(
      runDir,
      state,
      binding,
      prepared.agentInfo,
      prepared.prompt,
      prepared.nodeTimeoutMs,
    );
    return await this.finishAcpPrompt(runDir, state, node, context, prepared, prompt, binding);
  }

  private async initializeIsolatedSessionBundle(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
  ): Promise<void> {
    const timestamp = state.currentNodeStartedAt ?? isoNow();
    const initialRecord = createSyntheticSessionRecord({
      binding,
      createdAt: timestamp,
      updatedAt: timestamp,
      conversation: createSessionConversation(timestamp),
      acpxState: undefined,
      lastSeq: 0,
    });
    await this.store.ensureSessionBundle(runDir, state, binding, initialRecord);
  }

  private async executePersistentAcpPrompt(
    runDir: string,
    state: FlowRunState,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
    prepared: PreparedAcpPrompt,
    binding: FlowSessionBinding,
  ): Promise<FlowNodeExecutionResult> {
    await this.appendAcpPromptPreparedTrace(runDir, state, binding, prepared.promptArtifact);
    const prompt = await this.runPersistentPrompt(
      runDir,
      state,
      binding,
      prepared.prompt,
      prepared.nodeTimeoutMs,
    );
    return await this.finishAcpPrompt(
      runDir,
      state,
      node,
      context,
      prepared,
      prompt,
      prompt.sessionInfo,
    );
  }

  private async appendAcpPromptPreparedTrace(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    promptArtifact: FlowArtifactRef,
  ): Promise<void> {
    await this.store.appendTrace(runDir, state, {
      scope: "acp",
      type: "acp_prompt_prepared",
      nodeId: state.currentNode,
      attemptId: state.currentAttemptId,
      sessionId: binding.bundleId,
      payload: {
        sessionId: binding.bundleId,
        promptArtifact,
      },
    });
  }

  private async finishAcpPrompt(
    runDir: string,
    state: FlowRunState,
    node: AcpNodeDefinition,
    context: FlowNodeContext,
    prepared: PreparedAcpPrompt,
    prompt: TracedPromptResult,
    sessionInfo: FlowSessionBinding,
  ): Promise<FlowNodeExecutionResult> {
    const rawResponseArtifact = await this.writeAcpRawResponseArtifact(
      runDir,
      state,
      prompt,
      sessionInfo,
    );
    await this.appendAcpResponseParsedTrace(
      runDir,
      state,
      prompt,
      sessionInfo,
      rawResponseArtifact,
    );
    const trace: FlowStepTrace = {
      sessionId: sessionInfo.bundleId,
      promptArtifact: prepared.promptArtifact,
      rawResponseArtifact,
      conversation: prompt.conversation,
    };
    const output = await this.parseAcpOutput(node, context, prompt.rawText, trace);
    return {
      output,
      promptText: prepared.promptText,
      rawText: prompt.rawText,
      sessionInfo,
      agentInfo: prepared.agentInfo,
      trace,
    };
  }

  private async writeAcpRawResponseArtifact(
    runDir: string,
    state: FlowRunState,
    prompt: TracedPromptResult,
    sessionInfo: FlowSessionBinding,
  ): Promise<FlowArtifactRef> {
    return await this.store.writeArtifact(runDir, state, prompt.rawText, {
      mediaType: "text/plain",
      extension: "txt",
      nodeId: state.currentNode,
      attemptId: state.currentAttemptId,
      sessionId: sessionInfo.bundleId,
    });
  }

  private async appendAcpResponseParsedTrace(
    runDir: string,
    state: FlowRunState,
    prompt: TracedPromptResult,
    sessionInfo: FlowSessionBinding,
    rawResponseArtifact: FlowArtifactRef,
  ): Promise<void> {
    await this.store.appendTrace(runDir, state, {
      scope: "acp",
      type: "acp_response_parsed",
      nodeId: state.currentNode,
      attemptId: state.currentAttemptId,
      sessionId: sessionInfo.bundleId,
      payload: {
        sessionId: sessionInfo.bundleId,
        conversation: prompt.conversation,
        rawResponseArtifact,
      },
    });
  }

  private async parseAcpOutput(
    node: AcpNodeDefinition,
    context: FlowNodeContext,
    rawText: string,
    trace: FlowStepTrace,
  ): Promise<unknown> {
    try {
      return node.parse ? await node.parse(rawText, context) : rawText;
    } catch (error) {
      throw attachStepTrace(error, trace);
    }
  }

  private async runWithHeartbeat<T>(
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    node: FlowNodeCommon,
    timeoutMs: number | undefined,
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
        scope: "node",
        type: "node_heartbeat",
        nodeId,
        attemptId: state.currentAttemptId,
        payload: {
          statusDetail: state.statusDetail,
        },
      });
    };

    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        void heartbeat();
      }, heartbeatMs);
    }

    try {
      return await withTimeout(run(), timeoutMs);
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
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    agent: ResolvedFlowAgent,
    timeoutMs: number | undefined,
  ): Promise<FlowSessionBinding> {
    const handle = node.session?.handle ?? "main";
    const key = createSessionBindingKey(agent.agentCommand, agent.cwd, handle);
    const existing = state.sessionBindings[key];
    if (existing) {
      await this.store.ensureSessionBundle(runDir, state, existing);
      return existing;
    }

    const name = createSessionName(flow.name, handle, agent.cwd, state.runId);
    const created = await createSessionWithClient({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      name,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      permissionPolicy: this.permissionPolicy,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      timeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });

    const binding: FlowSessionBinding = {
      key,
      handle,
      bundleId: createSessionBundleId(handle, key),
      name,
      profile: node.profile,
      agentName: agent.agentName,
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      acpxRecordId: created.record.acpxRecordId,
      acpSessionId: created.record.acpSessionId,
      agentSessionId: created.record.agentSessionId,
    };
    state.sessionBindings[key] = binding;
    this.pendingPersistentSessionClients.set(binding.key, created.client);
    await this.store.ensureSessionBundle(runDir, state, binding, created.record);
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
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    prompt: PromptInput,
    timeoutMs?: number,
  ): Promise<TracedPromptResult> {
    const capture = createQuietCaptureOutput();
    const beforeRecord = await resolveSessionRecord(binding.acpxRecordId);
    let eventStartSeq: number | undefined;
    let eventEndSeq: number | undefined;
    const pendingEventWrites: Promise<void>[] = [];
    const initialClient = this.pendingPersistentSessionClients.get(binding.key);
    if (initialClient) {
      this.pendingPersistentSessionClients.delete(binding.key);
    }

    try {
      await sendSessionDirect({
        sessionId: binding.acpxRecordId,
        prompt,
        resumePolicy: "same-session-only",
        mcpServers: this.mcpServers,
        permissionMode: this.permissionMode,
        nonInteractivePermissions: this.nonInteractivePermissions,
        permissionPolicy: this.permissionPolicy,
        authCredentials: this.authCredentials,
        authPolicy: this.authPolicy,
        outputFormatter: capture.formatter,
        onAcpMessage: (direction, message) => {
          const pending = this.store
            .appendSessionEvent(runDir, binding, direction, message)
            .then((seq) => {
              eventStartSeq = eventStartSeq === undefined ? seq : Math.min(eventStartSeq, seq);
              eventEndSeq = eventEndSeq === undefined ? seq : Math.max(eventEndSeq, seq);
            });
          pendingEventWrites.push(pending);
        },
        suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
        timeoutMs,
        verbose: this.verbose,
        client: initialClient,
      });
      await Promise.all(pendingEventWrites);
      const sessionInfo = await this.refreshSessionBinding(binding);
      state.sessionBindings[sessionInfo.key] = sessionInfo;
      await this.store.ensureSessionBundle(runDir, state, sessionInfo);
      const afterRecord = await resolveSessionRecord(sessionInfo.acpxRecordId);
      await this.store.writeSessionRecord(runDir, state, sessionInfo, afterRecord);
      const messageStartResolved = findConversationDeltaStart(
        beforeRecord.messages,
        afterRecord.messages,
      );

      return {
        rawText: capture.read(),
        sessionInfo,
        conversation: {
          sessionId: sessionInfo.bundleId,
          messageStart: messageStartResolved,
          messageEnd: Math.max(messageStartResolved, afterRecord.messages.length - 1),
          eventStartSeq:
            eventStartSeq ??
            (() => {
              throw new Error(`Missing ACP event capture for session ${sessionInfo.bundleId}`);
            })(),
          eventEndSeq:
            eventEndSeq ??
            (() => {
              throw new Error(`Missing ACP event capture for session ${sessionInfo.bundleId}`);
            })(),
        },
      };
    } finally {
      if (initialClient) {
        await initialClient.close().catch(() => {
          // best effort cleanup; persisted session state already exists
        });
      }
    }
  }

  private async closePendingPersistentSessionClients(): Promise<void> {
    const pendingClients = [...this.pendingPersistentSessionClients.values()];
    this.pendingPersistentSessionClients.clear();
    await Promise.all(
      pendingClients.map(async (client) => {
        await client.close().catch(() => {
          // best effort on flow shutdown
        });
      }),
    );
  }

  private async runIsolatedPrompt(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    agent: ResolvedFlowAgent,
    prompt: PromptInput,
    timeoutMs?: number,
  ): Promise<TracedPromptResult> {
    const capture = createQuietCaptureOutput();
    const conversation = createSessionConversation(state.currentNodeStartedAt ?? isoNow());
    let acpxState: SessionRecord["acpx"] | undefined;
    recordPromptSubmission(conversation, prompt, state.currentNodeStartedAt ?? isoNow());
    let eventStartSeq: number | undefined;
    let eventEndSeq: number | undefined;
    const pendingEventWrites: Promise<void>[] = [];
    const result = await runOnce({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      permissionPolicy: this.permissionPolicy,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      outputFormatter: capture.formatter,
      onAcpMessage: (direction, message) => {
        const pending = this.store
          .appendSessionEvent(runDir, binding, direction, message)
          .then((seq) => {
            eventStartSeq = eventStartSeq === undefined ? seq : Math.min(eventStartSeq, seq);
            eventEndSeq = eventEndSeq === undefined ? seq : Math.max(eventEndSeq, seq);
          });
        pendingEventWrites.push(pending);
      },
      onSessionUpdate: (notification) => {
        acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      },
      onClientOperation: (operation) => {
        acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      },
      suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
      timeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });
    await Promise.all(pendingEventWrites);
    const sessionInfo: FlowSessionBinding = {
      ...binding,
      acpxRecordId: result.sessionId,
      acpSessionId: result.sessionId,
    };
    await this.store.ensureSessionBundle(runDir, state, sessionInfo);
    const syntheticRecord = createSyntheticSessionRecord({
      binding: sessionInfo,
      createdAt: state.currentNodeStartedAt ?? isoNow(),
      updatedAt: conversation.updated_at,
      conversation,
      acpxState: cloneSessionAcpxState(acpxState),
      lastSeq: eventEndSeq ?? 0,
    });
    await this.store.writeSessionRecord(runDir, state, sessionInfo, syntheticRecord);
    return {
      rawText: capture.read(),
      sessionInfo,
      conversation: {
        sessionId: sessionInfo.bundleId,
        messageStart: 0,
        messageEnd: Math.max(0, conversation.messages.length - 1),
        eventStartSeq:
          eventStartSeq ??
          (() => {
            throw new Error(`Missing ACP event capture for session ${sessionInfo.bundleId}`);
          })(),
        eventEndSeq:
          eventEndSeq ??
          (() => {
            throw new Error(`Missing ACP event capture for session ${sessionInfo.bundleId}`);
          })(),
      },
    };
  }
}
