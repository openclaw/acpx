import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createOutputFormatter } from "../output.js";
import { promptToDisplayText, textPrompt } from "../prompt-content.js";
import { resolveSessionRecord } from "../session-persistence.js";
import { InterruptedError, TimeoutError, withTimeout } from "../session-runtime-helpers.js";
import { cancelSessionPrompt, createSession, runOnce, sendSession } from "../session.js";
import type { PromptInput } from "../types.js";
import { acp, action, checkpoint, compute, defineFlow, shell } from "./definition.js";
import { formatShellActionSummary, runShellAction } from "./executors/shell.js";
import { resolveNext, resolveNextForOutcome, validateFlowDefinition } from "./graph.js";
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
  FlowRunResult,
  FlowRunState,
  FlowRunnerOptions,
  FlowSessionBinding,
  FlowEdge,
  FlowStepRecord,
  FlowNodeOutcome,
  FlowNodeResult,
  FunctionActionNodeDefinition,
  ResolvedFlowAgent,
  ShellActionExecution,
  ShellActionNodeDefinition,
  ShellActionResult,
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

type MemoryWritable = {
  write(chunk: string): void;
};

type FlowNodeExecutionResult = {
  output: unknown;
  promptText: string | null;
  rawText: string | null;
  sessionInfo: FlowSessionBinding | null;
  agentInfo: ResolvedFlowAgent | null;
};

export class FlowRunner {
  private readonly resolveAgent;
  private readonly defaultCwd;
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
    this.defaultCwd = options.resolveAgent(undefined).cwd;
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
    this.store = new FlowRunStore(options.outputRoot);
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
      results: {},
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
        let agentInfo: ResolvedFlowAgent | null = null;
        this.markNodeStarted(state, current, node.kind, startedAt, node.statusDetail);
        await this.store.writeSnapshot(runDir, state, {
          type: "node_started",
          nodeId: current,
          kind: node.kind,
        });
        let nodeResult: FlowNodeResult | undefined;
        let executionError: unknown;
        try {
          ({ output, promptText, rawText, sessionInfo, agentInfo } = await this.executeNode(
            runDir,
            state,
            flow,
            current,
            node,
            context,
          ));
          nodeResult = createNodeResult({
            nodeId: current,
            kind: node.kind,
            outcome: "ok",
            startedAt,
            finishedAt: isoNow(),
            output,
          });
        } catch (error) {
          executionError = error;
          nodeResult = createNodeResult({
            nodeId: current,
            kind: node.kind,
            outcome: outcomeForError(error),
            startedAt,
            finishedAt: isoNow(),
            error: error instanceof Error ? error.message : String(error),
          });
        }

        state.results[current] = nodeResult;

        if (nodeResult.outcome === "ok" && node.kind === "checkpoint") {
          state.outputs[current] = output;
          state.waitingOn = current;
          state.updatedAt = isoNow();
          state.status = "waiting";
          this.clearActiveNode(state, (output as { summary?: string } | null)?.summary ?? current);
          state.steps.push({
            nodeId: current,
            kind: node.kind,
            outcome: nodeResult.outcome,
            startedAt,
            finishedAt: nodeResult.finishedAt,
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

        if (nodeResult.outcome === "ok") {
          state.outputs[current] = output;
        }
        state.updatedAt = isoNow();
        this.clearActiveNode(state);
        state.steps.push({
          nodeId: current,
          kind: node.kind,
          outcome: nodeResult.outcome,
          startedAt,
          finishedAt: nodeResult.finishedAt,
          promptText,
          rawText,
          output,
          error: nodeResult.error,
          session: sessionInfo,
          agent: agentInfo,
        });

        if (nodeResult.outcome === "ok") {
          await this.store.writeSnapshot(runDir, state, {
            type: "node_completed",
            nodeId: current,
            output,
          });
          current = resolveNext(flow.edges, current, output, nodeResult);
          continue;
        }

        await this.store.writeSnapshot(runDir, state, {
          type: "node_outcome",
          nodeId: current,
          outcome: nodeResult.outcome,
          error: nodeResult.error,
        });

        const next = resolveNextForOutcome(flow.edges, current, nodeResult);
        if (next) {
          current = next;
          continue;
        }

        throw executionError;
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
      results: state.results,
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
      };
    }

    const { output, rawText } = await this.runWithHeartbeat(
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
        this.updateStatusDetail(state, formatShellActionSummary(effectiveExecution));
        await this.store.writeLive(runDir, state, {
          type: "node_detail",
          nodeId: state.currentNode,
          detail: state.statusDetail,
        });
        const result = await runShellAction(effectiveExecution);
        return {
          output: node.parse ? await node.parse(result, context) : result,
          rawText: result.combinedOutput,
        };
      },
    );
    return {
      output,
      promptText: null,
      rawText,
      sessionInfo: null,
      agentInfo: null,
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
        const resolvedAgent = this.resolveAgent(node.profile);
        const agentInfo = {
          ...resolvedAgent,
          cwd: await resolveNodeCwd(resolvedAgent.cwd, node.cwd, context),
        };
        const prompt = normalizePromptInput(await Promise.resolve(node.prompt(context)));
        const promptText = promptToDisplayText(prompt);
        this.updateStatusDetail(state, summarizePrompt(promptText, node.statusDetail));
        await this.store.writeLive(runDir, state, {
          type: "node_detail",
          nodeId: state.currentNode,
          detail: state.statusDetail,
        });

        if (node.session?.isolated) {
          const rawText = await this.runIsolatedPrompt(agentInfo, prompt, nodeTimeoutMs);
          return {
            output: node.parse ? await node.parse(rawText, context) : rawText,
            promptText,
            rawText,
            sessionInfo: null,
            agentInfo,
          };
        }

        boundSession = await this.ensureSessionBinding(state, flow, node, agentInfo, nodeTimeoutMs);
        const rawText = await this.runPersistentPrompt(boundSession, prompt, nodeTimeoutMs);
        const sessionInfo = await this.refreshSessionBinding(boundSession);
        state.sessionBindings[sessionInfo.key] = sessionInfo;
        return {
          output: node.parse ? await node.parse(rawText, context) : rawText,
          promptText,
          rawText,
          sessionInfo,
          agentInfo,
        };
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
      timeoutMs,
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
    agent: ResolvedFlowAgent,
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

function normalizePromptInput(prompt: PromptInput | string): PromptInput {
  return typeof prompt === "string" ? textPrompt(prompt) : prompt;
}

async function resolveNodeCwd(
  defaultCwd: string,
  cwd: AcpNodeDefinition["cwd"],
  context: FlowNodeContext,
): Promise<string> {
  if (typeof cwd === "function") {
    const resolved = (await cwd(context)) ?? defaultCwd;
    return path.resolve(defaultCwd, resolved);
  }
  return path.resolve(defaultCwd, cwd ?? defaultCwd);
}

function resolveShellActionCwd(defaultCwd: string, cwd: string | undefined): string {
  return path.resolve(defaultCwd, cwd ?? defaultCwd);
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

function createNodeResult(options: {
  nodeId: string;
  kind: FlowNodeDefinition["kind"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
}): FlowNodeResult {
  return {
    nodeId: options.nodeId,
    kind: options.kind,
    outcome: options.outcome,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    durationMs: new Date(options.finishedAt).getTime() - new Date(options.startedAt).getTime(),
    output: options.output,
    error: options.error,
  };
}

function outcomeForError(error: unknown): FlowNodeOutcome {
  if (error instanceof TimeoutError) {
    return "timed_out";
  }
  if (error instanceof InterruptedError) {
    return "cancelled";
  }
  return "failed";
}

function stableShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function isoNow(): string {
  return new Date().toISOString();
}
