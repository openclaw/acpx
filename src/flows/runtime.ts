import type { AcpClient } from "../acp/client.js";
import { InterruptedError, withInterrupt } from "../async-control.js";
import { promptToDisplayText } from "../prompt-content.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
} from "../session/conversation-model.js";
import { resolveSessionRecord } from "../session/persistence.js";
import { createSessionWithClient, runOnce, sendSessionDirect } from "../session/session.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  PromptInput,
  SessionRecord,
} from "../types.js";
import { FlowAttempt } from "./attempt.js";
import { acp, action, checkpoint, compute, defineFlow, shell } from "./definition.js";
import {
  formatShellActionSummary,
  resolveShellActionTimeoutMs,
  runShellAction,
  runShellCommand,
  type RunShellActionOptions,
  type ShellProcessOwner,
} from "./executors/shell.js";
import { resolveNext, validateFlowDefinition } from "./graph.js";
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
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FunctionActionNodeDefinition,
  FlowDefinition,
  FlowNodeCommon,
  FlowNodeContext,
  FlowShellExecution,
  FlowShellResult,
  FlowNodeDefinition,
  FlowStepTrace,
  FlowArtifactRef,
  FlowRunResult,
  FlowRunState,
  FlowRunnerOptions,
  FlowSessionBinding,
  FlowNodeResult,
  FlowNodeOutcome,
  ResolvedFlowAgent,
  ShellActionExecution,
  ShellActionNodeDefinition,
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
  FlowShellExecution,
  FlowShellResult,
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
  attempt: FlowAttempt;
};

type FlowAttemptContext = {
  nodeContext: FlowNodeContext;
  attempt: FlowAttempt;
};

export class FlowRunner {
  private readonly resolveAgent;
  private readonly defaultCwd;
  private readonly connectionOptions;
  private readonly defaultNodeTimeoutMs;
  private readonly suppressSdkConsoleErrors?;
  private readonly sessionOptions?;
  private readonly services;
  private readonly store;
  private readonly pendingPersistentSessionClients = new Map<string, Map<string, AcpClient>>();
  private readonly attempts = new Map<string, FlowAttempt>();
  private readonly pendingClientReleases = new WeakMap<AcpClient, () => void>();
  private readonly runInterruptions = new Map<string, InterruptedError>();
  private readonly shellOwners = new Map<string, Set<ShellProcessOwner>>();

  constructor(options: FlowRunnerOptions) {
    this.resolveAgent = options.resolveAgent;
    this.defaultCwd = options.resolveAgent(undefined).cwd;
    this.connectionOptions = {
      permissionMode: options.permissionMode,
      mcpServers: options.mcpServers,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      verbose: options.verbose,
    };
    this.defaultNodeTimeoutMs =
      options.defaultNodeTimeoutMs ?? options.timeoutMs ?? DEFAULT_FLOW_STEP_TIMEOUT_MS;
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
      return await this.runWithOwnership(flow, input, runDir, state);
    } finally {
      await this.closePendingPersistentSessionClients(runDir);
    }
  }

  private async runWithOwnership(
    flow: FlowDefinition,
    input: unknown,
    runDir: string,
    state: FlowRunState,
  ): Promise<FlowRunResult> {
    let execution: Promise<FlowRunResult> | undefined;
    let cancellation: Promise<void> | undefined;
    let interruption: InterruptedError | undefined;
    const result = await withInterrupt(
      () => {
        execution = this.executeFlowRun(flow, input, runDir, state);
        return execution;
      },
      async (signal) => {
        const reason = interruption ?? new InterruptedError();
        interruption = reason;
        this.runInterruptions.set(runDir, reason);
        cancellation ??= this.cancelShellOwners(runDir, signal);
        void cancellation.catch(() => {});
        this.attempts.get(runDir)?.cancel(reason, signal);
        await execution?.catch(() => {});
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      try {
        await cancellation;
      } catch (cleanupError) {
        const failure =
          result.ok || result.error === cleanupError
            ? cleanupError
            : new AggregateError(
                [result.error, cleanupError],
                "Shell cleanup failed during interruption",
                { cause: cleanupError },
              );
        await persistRunFailure(this.store, runDir, state, failure);
        throw failure;
      }
      if (result.ok && !interruption) {
        return result.value;
      }
      const failure = result.ok ? interruption : result.error;
      if (interruption) {
        await persistRunFailure(this.store, runDir, state, failure);
      }
      throw failure;
    } finally {
      this.releaseShellOwners(runDir);
    }
  }

  private registerShellOwner(runDir: string, owner: ShellProcessOwner): () => void {
    let owners = this.shellOwners.get(runDir);
    if (!owners) {
      owners = new Set();
      this.shellOwners.set(runDir, owners);
    }
    owners.add(owner);
    const registered = owners;
    return () => {
      registered.delete(owner);
      if (registered.size === 0) {
        this.shellOwners.delete(runDir);
      }
    };
  }

  private async cancelShellOwners(runDir: string, signal: NodeJS.Signals): Promise<void> {
    const owners = [...(this.shellOwners.get(runDir) ?? [])];
    const results = await Promise.allSettled(owners.map((owner) => owner.cancel(signal)));
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Shell process cleanup failed", { cause: errors[0] });
    }
  }

  private releaseShellOwners(runDir: string): void {
    for (const owner of this.shellOwners.get(runDir) ?? []) {
      owner.release();
    }
    this.shellOwners.delete(runDir);
  }

  private async executeFlowRun(
    flow: FlowDefinition,
    input: unknown,
    runDir: string,
    state: FlowRunState,
  ): Promise<FlowRunResult> {
    let current: string | null = flow.startAt;
    const attemptCounts = new Map<string, number>();
    try {
      while (current) {
        this.throwIfRunInterrupted(runDir);
        const step = await this.executeFlowStep(flow, input, runDir, state, current, attemptCounts);
        this.throwIfRunInterrupted(runDir, step.executionError);
        const waiting = await this.maybeCompleteCheckpointStep(runDir, state, step);
        if (waiting) {
          return waiting;
        }
        await this.recordFlowStepOutcome(runDir, state, step);
        current = this.resolveNextNode(flow, step);
      }
      return await this.completeFlowRun(runDir, state);
    } catch (error) {
      if (!this.runInterruptions.has(runDir)) {
        await persistRunFailure(this.store, runDir, state, error);
      }
      throw error;
    } finally {
      this.runInterruptions.delete(runDir);
    }
  }

  private throwIfRunInterrupted(runDir: string, error?: unknown): void {
    const interrupted = this.runInterruptions.get(runDir);
    if (interrupted) {
      throw error ?? interrupted;
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
    const attempt = new FlowAttempt({
      nodeId,
      attemptId,
      startedAt,
      timeoutMs: node.timeoutMs ?? this.defaultNodeTimeoutMs,
    });
    this.attempts.set(runDir, attempt);
    const context = this.makeAttemptContext(runDir, state, input, node, attempt);
    let stopHeartbeat = () => {};
    let executed: FlowNodeExecutionResult;
    let outcome: FlowNodeOutcome = "ok";
    let executionError: unknown;
    try {
      this.throwIfRunInterrupted(runDir);
      executed = await attempt.run(async () => {
        await attempt.own(() =>
          this.writeNodeStartedSnapshot(runDir, state, nodeId, attemptId, node),
        );
        stopHeartbeat = this.startHeartbeat(runDir, state, node, attempt);
        const result = await this.executeNode(runDir, state, flow, nodeId, node, context);
        result.trace = await attempt.own(() =>
          finalizeStepTrace(
            this.store,
            runDir,
            state,
            nodeId,
            attemptId,
            result.output,
            result.trace,
          ),
        );
        return result;
      });
      this.throwIfRunInterrupted(runDir);
    } catch (error) {
      outcome = outcomeForError(error);
      executionError = error;
      executed = {
        output: undefined,
        promptText: null,
        rawText: null,
        sessionInfo: null,
        agentInfo: null,
        trace: await finalizeStepTrace(
          this.store,
          runDir,
          state,
          nodeId,
          attemptId,
          undefined,
          extractAttachedStepTrace(error) ?? null,
        ),
      };
    } finally {
      stopHeartbeat();
      this.attempts.delete(runDir);
    }
    const nodeResult = createNodeResult({
      attemptId,
      nodeId,
      nodeType: node.nodeType,
      outcome,
      startedAt,
      finishedAt: isoNow(),
      ...(outcome === "ok"
        ? { output: executed.output }
        : {
            error:
              executionError instanceof Error ? executionError.message : String(executionError),
          }),
    });
    state.results[nodeId] = nodeResult;
    return { ...executed, nodeResult, executionError, attemptId, nodeId, node, startedAt, state };
  }

  private makeAttemptContext(
    runDir: string,
    state: FlowRunState,
    input: unknown,
    node: FlowNodeDefinition,
    attempt: FlowAttempt,
  ): FlowAttemptContext {
    const context: FlowAttemptContext = {
      nodeContext: { ...makeFlowNodeContext(state, input, this.services), signal: attempt.signal },
      attempt,
    };
    if (node.nodeType === "action" && "run" in node) {
      context.nodeContext.runShell = (execution) =>
        this.runCallbackShell(runDir, attempt, execution);
    }
    return context;
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
        timeoutMs: node.timeoutMs ?? this.defaultNodeTimeoutMs,
        ...(state.statusDetail ? { statusDetail: state.statusDetail } : {}),
      },
    });
  }

  private async maybeCompleteCheckpointStep(
    runDir: string,
    state: FlowRunState,
    step: FlowStepExecutionResult,
  ): Promise<FlowRunResult | undefined> {
    if (step.nodeResult.outcome !== "ok" || step.node.nodeType !== "checkpoint") {
      return undefined;
    }
    state.outputs[step.nodeId] = step.output;
    state.waitingOn = step.nodeId;
    state.updatedAt = isoNow();
    state.status = "waiting";
    await this.recordFlowStepOutcome(runDir, state, step, {
      statusDetail: (step.output as { summary?: string } | null)?.summary ?? step.nodeId,
    });
    return { runDir, state };
  }

  private resolveNextNode(flow: FlowDefinition, step: FlowStepExecutionResult): string | null {
    if (step.nodeResult.outcome === "ok") {
      step.state.outputs[step.nodeId] = step.output;
      return resolveNext(flow.edges, step.nodeId, step.output, step.nodeResult);
    }
    const next = resolveNext(flow.edges, step.nodeId, undefined, step.nodeResult);
    if (next) {
      return next;
    }
    throw step.executionError;
  }

  private async completeFlowRun(runDir: string, state: FlowRunState): Promise<FlowRunResult> {
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
      session: step.sessionInfo,
      agent: step.agentInfo,
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
    context: FlowAttemptContext,
  ): Promise<FlowNodeExecutionResult> {
    switch (node.nodeType) {
      case "compute":
        return await this.executeCallbackNode(nodeId, node, context);
      case "action":
        return "run" in node
          ? await this.executeCallbackNode(nodeId, node, context)
          : await this.executeShellNode(runDir, state, node, context);
      case "checkpoint":
        return await this.executeCallbackNode(nodeId, node, context);
      case "acp":
        return await this.executeAcpNode(runDir, state, flow, node, context);
      default: {
        const exhaustive: never = node;
        throw new Error(`Unsupported flow node: ${String(exhaustive)}`);
      }
    }
  }

  private async executeCallbackNode(
    nodeId: string,
    node: ComputeNodeDefinition | FunctionActionNodeDefinition | CheckpointNodeDefinition,
    context: FlowAttemptContext,
  ): Promise<FlowNodeExecutionResult> {
    context.attempt.assertActive();
    const output =
      node.nodeType === "checkpoint" && typeof node.run !== "function"
        ? { checkpoint: nodeId, summary: node.summary ?? nodeId }
        : await node.run?.(context.nodeContext);
    context.attempt.assertActive();
    return {
      output,
      promptText: null,
      rawText: null,
      sessionInfo: null,
      agentInfo: null,
      trace: node.nodeType === "action" ? { action: { actionType: "function" } } : null,
    };
  }

  private async executeShellNode(
    runDir: string,
    state: FlowRunState,
    node: ShellActionNodeDefinition,
    context: FlowAttemptContext,
  ): Promise<FlowNodeExecutionResult> {
    const attempt = context.attempt;
    const execution = await node.exec(context.nodeContext);
    attempt.assertActive();
    const effectiveExecution: ShellActionExecution = {
      ...execution,
      cwd: resolveShellActionCwd(this.defaultCwd, execution.cwd),
      timeoutMs: resolveShellActionTimeoutMs(execution.timeoutMs ?? attempt.remainingTimeoutMs()),
    };
    updateStatusDetail(state, formatShellActionSummary(effectiveExecution));
    await attempt.own(() =>
      this.store.writeLive(runDir, state, {
        scope: "node",
        type: "node_heartbeat",
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        payload: { statusDetail: state.statusDetail },
      }),
    );
    await attempt.own(() =>
      this.store.appendTrace(runDir, state, {
        scope: "action",
        type: "action_prepared",
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        payload: {
          action: {
            actionType: "shell",
            command: effectiveExecution.command,
            args: effectiveExecution.args ?? [],
            cwd: effectiveExecution.cwd,
          },
        },
      }),
    );
    const result = await attempt.own(() =>
      runShellAction(effectiveExecution, this.shellControl(runDir, attempt)),
    );
    const stdoutArtifact = await attempt.own(() =>
      this.store.writeArtifact(runDir, state, result.stdout, {
        mediaType: "text/plain",
        extension: "txt",
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
      }),
    );
    const stderrArtifact = await attempt.own(() =>
      this.store.writeArtifact(runDir, state, result.stderr, {
        mediaType: "text/plain",
        extension: "txt",
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
      }),
    );
    const actionTrace = {
      actionType: "shell" as const,
      command: result.command,
      args: result.args,
      cwd: result.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    };
    await attempt.own(() =>
      this.store.appendTrace(runDir, state, {
        scope: "action",
        type: "action_completed",
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        payload: { action: actionTrace, stdoutArtifact, stderrArtifact },
      }),
    );
    const trace: FlowStepTrace = { action: actionTrace, stdoutArtifact, stderrArtifact };
    let output: unknown;
    try {
      output = node.parse ? await node.parse(result, context.nodeContext) : result;
      attempt.assertActive();
    } catch (error) {
      throw attachStepTrace(error, trace);
    }
    return {
      output,
      promptText: null,
      rawText: result.combinedOutput,
      sessionInfo: null,
      agentInfo: null,
      trace,
    };
  }

  private shellControl(runDir: string, attempt: FlowAttempt): RunShellActionOptions {
    return {
      signal: attempt.signal,
      get terminationSignal() {
        return attempt.terminationSignal;
      },
      registerOwner: (owner) => {
        const releaseAttempt = attempt.registerCancellation((signal) => owner.cancel(signal));
        const releaseRun = this.registerShellOwner(runDir, owner);
        return () => {
          releaseAttempt();
          releaseRun();
        };
      },
    };
  }

  private runCallbackShell(
    runDir: string,
    attempt: FlowAttempt,
    execution: FlowShellExecution,
  ): Promise<FlowShellResult> {
    return attempt.own(() =>
      runShellCommand(
        {
          ...execution,
          cwd: resolveShellActionCwd(this.defaultCwd, execution.cwd),
        },
        this.shellControl(runDir, attempt),
      ),
    );
  }

  private async executeAcpNode(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    context: FlowAttemptContext,
  ): Promise<FlowNodeExecutionResult> {
    const attempt = context.attempt;
    const prepared = await this.prepareAcpPrompt(runDir, state, node, context);
    if (node.session?.isolated) {
      return await this.executeIsolatedAcpPrompt(runDir, state, flow, node, context, prepared);
    }
    const boundSession = await this.ensureSessionBinding(
      runDir,
      state,
      flow,
      node,
      prepared.agentInfo,
      attempt,
    );
    return await this.executePersistentAcpPrompt(
      runDir,
      state,
      node,
      context,
      prepared,
      boundSession,
    );
  }

  private async prepareAcpPrompt(
    runDir: string,
    state: FlowRunState,
    node: AcpNodeDefinition,
    context: FlowAttemptContext,
  ): Promise<PreparedAcpPrompt> {
    const resolvedAgent = this.resolveAgent(node.profile);
    const agentInfo = {
      ...resolvedAgent,
      cwd: await resolveNodeCwd(resolvedAgent.cwd, node.cwd, context.nodeContext),
    };
    context.attempt.assertActive();
    const prompt = normalizePromptInput(await Promise.resolve(node.prompt(context.nodeContext)));
    context.attempt.assertActive();
    const promptText = promptToDisplayText(prompt);
    updateStatusDetail(state, summarizePrompt(promptText, node.statusDetail));
    await context.attempt.own(() => this.writeAcpPromptHeartbeat(runDir, state, context.attempt));
    const promptArtifact = await context.attempt.own(() =>
      this.store.writeArtifact(runDir, state, promptText, {
        mediaType: "text/plain",
        extension: "txt",
        nodeId: context.attempt.nodeId,
        attemptId: context.attempt.attemptId,
      }),
    );
    return {
      agentInfo,
      prompt,
      promptText,
      promptArtifact,
      attempt: context.attempt,
    };
  }

  private async writeAcpPromptHeartbeat(
    runDir: string,
    state: FlowRunState,
    attempt: FlowAttempt,
  ): Promise<void> {
    await this.store.writeLive(runDir, state, {
      scope: "node",
      type: "node_heartbeat",
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
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
    context: FlowAttemptContext,
    prepared: PreparedAcpPrompt,
  ): Promise<FlowNodeExecutionResult> {
    const binding = createIsolatedSessionBinding(
      flow.name,
      state.runId,
      prepared.attempt.attemptId,
      node.profile,
      prepared.agentInfo,
    );
    await prepared.attempt.own(() =>
      this.initializeIsolatedSessionBundle(runDir, state, binding, prepared.attempt),
    );
    await prepared.attempt.own(() =>
      this.appendAcpPromptPreparedTrace(
        runDir,
        state,
        binding,
        prepared.promptArtifact,
        prepared.attempt,
      ),
    );
    const prompt = await prepared.attempt.own(() =>
      this.runIsolatedPrompt(
        runDir,
        state,
        binding,
        prepared.agentInfo,
        prepared.prompt,
        prepared.attempt,
      ),
    );
    return await this.finishAcpPrompt(runDir, state, node, context, prepared, prompt, binding);
  }

  private async initializeIsolatedSessionBundle(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    attempt: FlowAttempt,
  ): Promise<void> {
    const timestamp = attempt.startedAt;
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
    context: FlowAttemptContext,
    prepared: PreparedAcpPrompt,
    binding: FlowSessionBinding,
  ): Promise<FlowNodeExecutionResult> {
    await prepared.attempt.own(() =>
      this.appendAcpPromptPreparedTrace(
        runDir,
        state,
        binding,
        prepared.promptArtifact,
        prepared.attempt,
      ),
    );
    const prompt = await prepared.attempt.own(() =>
      this.runPersistentPrompt(runDir, state, binding, prepared.prompt, prepared.attempt),
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
    attempt: FlowAttempt,
  ): Promise<void> {
    await this.store.appendTrace(runDir, state, {
      scope: "acp",
      type: "acp_prompt_prepared",
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
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
    context: FlowAttemptContext,
    prepared: PreparedAcpPrompt,
    prompt: TracedPromptResult,
    sessionInfo: FlowSessionBinding,
  ): Promise<FlowNodeExecutionResult> {
    const rawResponseArtifact = await prepared.attempt.own(() =>
      this.writeAcpRawResponseArtifact(runDir, state, prompt, sessionInfo, prepared.attempt),
    );
    await prepared.attempt.own(() =>
      this.appendAcpResponseParsedTrace(
        runDir,
        state,
        prompt,
        sessionInfo,
        rawResponseArtifact,
        prepared.attempt,
      ),
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
    attempt: FlowAttempt,
  ): Promise<FlowArtifactRef> {
    return await this.store.writeArtifact(runDir, state, prompt.rawText, {
      mediaType: "text/plain",
      extension: "txt",
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
      sessionId: sessionInfo.bundleId,
    });
  }

  private async appendAcpResponseParsedTrace(
    runDir: string,
    state: FlowRunState,
    prompt: TracedPromptResult,
    sessionInfo: FlowSessionBinding,
    rawResponseArtifact: FlowArtifactRef,
    attempt: FlowAttempt,
  ): Promise<void> {
    await this.store.appendTrace(runDir, state, {
      scope: "acp",
      type: "acp_response_parsed",
      nodeId: attempt.nodeId,
      attemptId: attempt.attemptId,
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
    context: FlowAttemptContext,
    rawText: string,
    trace: FlowStepTrace,
  ): Promise<unknown> {
    try {
      context.attempt.assertActive();
      const output = node.parse ? await node.parse(rawText, context.nodeContext) : rawText;
      context.attempt.assertActive();
      return output;
    } catch (error) {
      throw attachStepTrace(error, trace);
    }
  }

  private startHeartbeat(
    runDir: string,
    state: FlowRunState,
    node: FlowNodeCommon,
    attempt: FlowAttempt,
  ): () => void {
    const heartbeatMs = Math.max(0, Math.round(node.heartbeatMs ?? DEFAULT_FLOW_HEARTBEAT_MS));
    if (heartbeatMs === 0) {
      return () => {};
    }
    let pending = false;
    const heartbeat = async () => {
      if (!attempt.active || pending) {
        return;
      }
      pending = true;
      try {
        await attempt.own(
          async () => {
            state.lastHeartbeatAt = isoNow();
            state.updatedAt = state.lastHeartbeatAt;
            await this.store.writeLive(runDir, state, {
              scope: "node",
              type: "node_heartbeat",
              nodeId: attempt.nodeId,
              attemptId: attempt.attemptId,
              payload: { statusDetail: state.statusDetail },
            });
          },
          { bestEffort: true },
        );
      } catch {
        /* Heartbeats remain best-effort, including retirement at the deadline. */
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void heartbeat();
    }, heartbeatMs);
    return () => clearInterval(timer);
  }

  private async ensureSessionBinding(
    runDir: string,
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    agent: ResolvedFlowAgent,
    attempt: FlowAttempt,
  ): Promise<FlowSessionBinding> {
    const handle = node.session?.handle ?? "main";
    const key = createSessionBindingKey(agent.agentCommand, agent.cwd, handle);
    const existing = state.sessionBindings[key];
    if (existing) {
      await attempt.own(() => this.store.ensureSessionBundle(runDir, state, existing));
      return existing;
    }

    const name = createSessionName(flow.name, handle, agent.cwd, state.runId);
    const created = await attempt.own(async () => {
      const acquired = await createSessionWithClient({
        agentCommand: agent.agentCommand,
        agentArgv: agent.agentArgv,
        cwd: agent.cwd,
        name,
        ...this.connectionOptions,
        signal: attempt.signal,
        handleProcessInterrupts: false,
        sessionOptions: this.sessionOptions,
      });
      this.pendingClientReleases.set(
        acquired.client,
        attempt.registerCancellation(async () => {
          const clients = this.pendingPersistentSessionClients.get(runDir);
          if (clients?.get(key) === acquired.client) {
            clients.delete(key);
          }
          await acquired.client.close();
        }),
      );
      return acquired;
    });
    attempt.assertActive();

    const binding: FlowSessionBinding = {
      key,
      handle,
      bundleId: createSessionBundleId(handle, key),
      name,
      profile: node.profile,
      agentName: agent.agentName,
      agentCommand: agent.agentCommand,
      agentArgv: agent.agentArgv,
      cwd: agent.cwd,
      acpxRecordId: created.record.acpxRecordId,
      acpSessionId: created.record.acpSessionId,
      agentSessionId: created.record.agentSessionId,
    };
    state.sessionBindings[key] = binding;
    let clients = this.pendingPersistentSessionClients.get(runDir);
    if (!clients) {
      clients = new Map();
      this.pendingPersistentSessionClients.set(runDir, clients);
    }
    clients.set(binding.key, created.client);
    await attempt.own(() => this.store.ensureSessionBundle(runDir, state, binding, created.record));
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

  private createPromptEventCapture(runDir: string, binding: FlowSessionBinding) {
    const pending = new Set<Promise<void>>();
    let ordinal = 0;
    let failure: { ordinal: number; reason: unknown } | undefined;
    let eventStartSeq: number | undefined;
    let eventEndSeq = 0;
    return {
      onAcpMessage: (direction: AcpMessageDirection, message: AcpJsonRpcMessage): void => {
        const index = ordinal++;
        const write = this.store
          .appendSessionEvent(runDir, binding, direction, message)
          .then(
            (seq) => {
              eventStartSeq = Math.min(eventStartSeq ?? seq, seq);
              eventEndSeq = Math.max(eventEndSeq, seq);
            },
            (reason: unknown) => {
              if (!failure || index < failure.ordinal) {
                failure = { ordinal: index, reason };
              }
            },
          )
          .finally(() => pending.delete(write));
        // Only unfinished I/O owns a promise; long prompts must not retain every
        // settled write. Error precedence still follows event admission order.
        pending.add(write);
      },
      async run<T>(operation: () => Promise<T>) {
        let result: PromiseSettledResult<T>;
        try {
          result = { status: "fulfilled", value: await operation() };
        } catch (reason) {
          result = { status: "rejected", reason };
        }
        await Promise.all(pending);
        if (result.status === "rejected") {
          throw result.reason;
        }
        if (failure) {
          throw failure.reason;
        }
        if (eventStartSeq === undefined) {
          throw new Error(`Missing ACP event capture for session ${binding.bundleId}`);
        }
        return { result: result.value, eventStartSeq, eventEndSeq };
      },
    };
  }

  private async runPersistentPrompt(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    prompt: PromptInput,
    attempt: FlowAttempt,
  ): Promise<TracedPromptResult> {
    const capture = createQuietCaptureOutput();
    const beforeRecord = await resolveSessionRecord(binding.acpxRecordId);
    attempt.assertActive();
    const events = this.createPromptEventCapture(runDir, binding);
    const clients = this.pendingPersistentSessionClients.get(runDir);
    const initialClient = clients?.get(binding.key);
    if (initialClient) {
      clients?.delete(binding.key);
      this.pendingClientReleases.get(initialClient)?.();
      this.pendingClientReleases.delete(initialClient);
    }

    const { eventStartSeq, eventEndSeq } = await events.run(() =>
      sendSessionDirect(
        {
          sessionId: binding.acpxRecordId,
          prompt,
          resumePolicy: "same-session-only",
          ...this.connectionOptions,
          outputFormatter: capture.formatter,
          errorEmissionPolicy: { queueErrorAlreadyEmitted: false },
          onAcpMessage: events.onAcpMessage,
          suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
          client: initialClient,
        },
        { signal: attempt.signal, handleProcessInterrupts: false },
      ),
    );
    attempt.assertActive();
    const sessionInfo = await this.refreshSessionBinding(binding);
    attempt.assertActive();
    state.sessionBindings[sessionInfo.key] = sessionInfo;
    await this.store.ensureSessionBundle(runDir, state, sessionInfo);
    attempt.assertActive();
    const afterRecord = await resolveSessionRecord(sessionInfo.acpxRecordId);
    attempt.assertActive();
    await this.store.writeSessionRecord(runDir, state, sessionInfo, afterRecord);
    attempt.assertActive();
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
        eventStartSeq,
        eventEndSeq,
      },
    };
  }

  private async closePendingPersistentSessionClients(runDir: string): Promise<void> {
    const pendingClients = [...(this.pendingPersistentSessionClients.get(runDir)?.values() ?? [])];
    this.pendingPersistentSessionClients.delete(runDir);
    await Promise.all(
      pendingClients.map(async (client) => {
        this.pendingClientReleases.get(client)?.();
        this.pendingClientReleases.delete(client);
        await client.close();
      }),
    );
  }

  private async runIsolatedPrompt(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    agent: ResolvedFlowAgent,
    prompt: PromptInput,
    attempt: FlowAttempt,
  ): Promise<TracedPromptResult> {
    const capture = createQuietCaptureOutput();
    const conversation = createSessionConversation(attempt.startedAt);
    let acpxState: SessionRecord["acpx"] | undefined;
    recordPromptSubmission(conversation, prompt, attempt.startedAt);
    const events = this.createPromptEventCapture(runDir, binding);
    const { result, eventStartSeq, eventEndSeq } = await events.run(() =>
      runOnce(
        {
          agentCommand: agent.agentCommand,
          agentArgv: agent.agentArgv,
          cwd: agent.cwd,
          prompt,
          ...this.connectionOptions,
          outputFormatter: capture.formatter,
          errorEmissionPolicy: { queueErrorAlreadyEmitted: false },
          onAcpMessage: events.onAcpMessage,
          onSessionUpdate: (notification) => {
            acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
          },
          onClientOperation: (operation) => {
            acpxState = recordConversationClientOperation(conversation, acpxState, operation);
          },
          suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
          sessionOptions: this.sessionOptions,
        },
        { signal: attempt.signal, handleProcessInterrupts: false },
      ),
    );
    attempt.assertActive();
    const sessionInfo: FlowSessionBinding = {
      ...binding,
      acpxRecordId: result.sessionId,
      acpSessionId: result.sessionId,
    };
    await this.store.ensureSessionBundle(runDir, state, sessionInfo);
    attempt.assertActive();
    const syntheticRecord = createSyntheticSessionRecord({
      binding: sessionInfo,
      createdAt: attempt.startedAt,
      updatedAt: conversation.updated_at,
      conversation,
      acpxState: cloneSessionAcpxState(acpxState),
      lastSeq: eventEndSeq,
    });
    await this.store.writeSessionRecord(runDir, state, sessionInfo, syntheticRecord);
    attempt.assertActive();
    return {
      rawText: capture.read(),
      sessionInfo,
      conversation: {
        sessionId: sessionInfo.bundleId,
        messageStart: 0,
        messageEnd: Math.max(0, conversation.messages.length - 1),
        eventStartSeq,
        eventEndSeq,
      },
    };
  }
}
