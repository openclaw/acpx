import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createOutputFormatter } from "../output.js";
import { promptToDisplayText, textPrompt } from "../prompt-content.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
} from "../session-conversation-model.js";
import { defaultSessionEventLog } from "../session-event-log.js";
import { resolveSessionRecord } from "../session-persistence.js";
import {
  InterruptedError,
  TimeoutError,
  withInterrupt,
  withTimeout,
} from "../session-runtime-helpers.js";
import { cancelSessionPrompt, createSession, runOnce, sendSessionDirect } from "../session.js";
import { SESSION_RECORD_SCHEMA } from "../types.js";
import type { PromptInput, SessionRecord } from "../types.js";
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
  FlowStepTrace,
  FlowPermissionRequirements,
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

type MemoryWritable = {
  write(chunk: string): void;
};

type FlowNodeExecutionResult = {
  output: unknown;
  promptText: string | null;
  rawText: string | null;
  sessionInfo: FlowSessionBinding | null;
  agentInfo: ResolvedFlowAgent | null;
  trace: FlowStepTrace | null;
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

    let current: string | null = flow.startAt;
    const attemptCounts = new Map<string, number>();

    return await withInterrupt(
      async () => {
        try {
          while (current) {
            const node = flow.nodes[current];
            if (!node) {
              throw new Error(`Unknown flow node: ${current}`);
            }

            const attemptId = nextAttemptId(attemptCounts, current);
            const startedAt = isoNow();
            const context = this.makeContext(state, input);
            let output: unknown;
            let promptText: string | null = null;
            let rawText: string | null = null;
            let sessionInfo: FlowSessionBinding | null = null;
            let agentInfo: ResolvedFlowAgent | null = null;
            let trace: FlowStepTrace | null = null;
            this.markNodeStarted(
              state,
              current,
              attemptId,
              node.nodeType,
              startedAt,
              node.statusDetail,
            );
            await this.store.writeSnapshot(runDir, state, {
              scope: "node",
              type: "node_started",
              nodeId: current,
              attemptId,
              payload: {
                nodeType: node.nodeType,
                ...(node.timeoutMs !== undefined
                  ? { timeoutMs: node.timeoutMs ?? this.defaultNodeTimeoutMs }
                  : { timeoutMs: this.defaultNodeTimeoutMs }),
                ...(state.statusDetail ? { statusDetail: state.statusDetail } : {}),
              },
            });
            let nodeResult: FlowNodeResult | undefined;
            let executionError: unknown;
            try {
              ({ output, promptText, rawText, sessionInfo, agentInfo, trace } =
                await this.executeNode(runDir, state, flow, current, node, context));
              trace = await this.finalizeStepTrace(
                runDir,
                state,
                current,
                attemptId,
                output,
                trace,
              );
              nodeResult = createNodeResult({
                attemptId,
                nodeId: current,
                nodeType: node.nodeType,
                outcome: "ok",
                startedAt,
                finishedAt: isoNow(),
                output,
              });
            } catch (error) {
              executionError = error;
              trace = extractAttachedStepTrace(error) ?? trace;
              trace = await this.finalizeStepTrace(
                runDir,
                state,
                current,
                attemptId,
                undefined,
                trace,
              );
              nodeResult = createNodeResult({
                attemptId,
                nodeId: current,
                nodeType: node.nodeType,
                outcome: outcomeForError(error),
                startedAt,
                finishedAt: isoNow(),
                error: error instanceof Error ? error.message : String(error),
              });
            }

            state.results[current] = nodeResult;

            if (nodeResult.outcome === "ok" && node.nodeType === "checkpoint") {
              state.outputs[current] = output;
              state.waitingOn = current;
              state.updatedAt = isoNow();
              state.status = "waiting";
              this.clearActiveNode(
                state,
                (output as { summary?: string } | null)?.summary ?? current,
              );
              state.steps.push({
                attemptId,
                nodeId: current,
                nodeType: node.nodeType,
                outcome: nodeResult.outcome,
                startedAt,
                finishedAt: nodeResult.finishedAt,
                promptText,
                rawText,
                output,
                session: null,
                agent: null,
                ...(trace ? { trace } : {}),
              });
              await this.store.writeSnapshot(runDir, state, {
                scope: "node",
                type: "node_outcome",
                nodeId: current,
                attemptId,
                payload: createNodeOutcomePayload(nodeResult, trace),
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
              attemptId,
              nodeId: current,
              nodeType: node.nodeType,
              outcome: nodeResult.outcome,
              startedAt,
              finishedAt: nodeResult.finishedAt,
              promptText,
              rawText,
              output,
              error: nodeResult.error,
              session: sessionInfo,
              agent: agentInfo,
              ...(trace ? { trace } : {}),
            });

            await this.store.writeSnapshot(runDir, state, {
              scope: "node",
              type: "node_outcome",
              nodeId: current,
              attemptId,
              payload: createNodeOutcomePayload(nodeResult, trace),
            });

            if (nodeResult.outcome === "ok") {
              current = resolveNext(flow.edges, current, output, nodeResult);
              continue;
            }

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
          await this.store.writeSnapshot(runDir, state, {
            scope: "run",
            type: "run_completed",
            payload: {
              status: state.status,
            },
          });
          return {
            runDir,
            state,
          };
        } catch (error) {
          await this.persistRunFailure(runDir, state, error);
          throw error;
        }
      },
      async () => {
        await this.persistRunFailure(runDir, state, new InterruptedError());
      },
    );
  }

  private async persistRunFailure(
    runDir: string,
    state: FlowRunState,
    error: unknown,
  ): Promise<void> {
    if (
      state.finishedAt !== undefined &&
      (state.status === "failed" || state.status === "timed_out")
    ) {
      return;
    }
    state.status = error instanceof TimeoutError ? "timed_out" : "failed";
    state.updatedAt = isoNow();
    state.finishedAt = state.updatedAt;
    state.error = error instanceof Error ? error.message : String(error);
    state.statusDetail = state.currentNode
      ? `Failed in ${state.currentNode}: ${state.error}`
      : state.error;
    await this.store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_failed",
      payload: {
        status: state.status,
        error: state.error,
      },
    });
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
        this.updateStatusDetail(state, formatShellActionSummary(effectiveExecution));
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
        const resolvedAgent = this.resolveAgent(node.profile);
        const agentInfo = {
          ...resolvedAgent,
          cwd: await resolveNodeCwd(resolvedAgent.cwd, node.cwd, context),
        };
        const prompt = normalizePromptInput(await Promise.resolve(node.prompt(context)));
        const promptText = promptToDisplayText(prompt);
        this.updateStatusDetail(state, summarizePrompt(promptText, node.statusDetail));
        await this.store.writeLive(runDir, state, {
          scope: "node",
          type: "node_heartbeat",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          payload: {
            statusDetail: state.statusDetail,
          },
        });
        const promptArtifact = await this.store.writeArtifact(runDir, state, promptText, {
          mediaType: "text/plain",
          extension: "txt",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
        });

        if (node.session?.isolated) {
          const isolatedBinding = createIsolatedSessionBinding(
            flow.name,
            state.runId,
            state.currentAttemptId ?? randomUUID(),
            node.profile,
            agentInfo,
          );
          const initialIsolatedRecord = createSyntheticSessionRecord({
            binding: isolatedBinding,
            createdAt: state.currentNodeStartedAt ?? isoNow(),
            updatedAt: state.currentNodeStartedAt ?? isoNow(),
            conversation: createSessionConversation(state.currentNodeStartedAt ?? isoNow()),
            acpxState: undefined,
            lastSeq: 0,
          });
          await this.store.ensureSessionBundle(
            runDir,
            state,
            isolatedBinding,
            initialIsolatedRecord,
          );
          await this.store.appendTrace(runDir, state, {
            scope: "acp",
            type: "acp_prompt_prepared",
            nodeId: state.currentNode,
            attemptId: state.currentAttemptId,
            sessionId: isolatedBinding.bundleId,
            payload: {
              sessionId: isolatedBinding.bundleId,
              promptArtifact,
            },
          });
          const isolatedPrompt = await this.runIsolatedPrompt(
            runDir,
            state,
            isolatedBinding,
            agentInfo,
            prompt,
            nodeTimeoutMs,
          );
          const rawResponseArtifact = await this.store.writeArtifact(
            runDir,
            state,
            isolatedPrompt.rawText,
            {
              mediaType: "text/plain",
              extension: "txt",
              nodeId: state.currentNode,
              attemptId: state.currentAttemptId,
              sessionId: isolatedBinding.bundleId,
            },
          );
          await this.store.appendTrace(runDir, state, {
            scope: "acp",
            type: "acp_response_parsed",
            nodeId: state.currentNode,
            attemptId: state.currentAttemptId,
            sessionId: isolatedBinding.bundleId,
            payload: {
              sessionId: isolatedBinding.bundleId,
              conversation: isolatedPrompt.conversation,
              rawResponseArtifact,
            },
          });
          const trace: FlowStepTrace = {
            sessionId: isolatedBinding.bundleId,
            promptArtifact,
            rawResponseArtifact,
            conversation: isolatedPrompt.conversation,
          };
          let parsedOutput: unknown;
          try {
            parsedOutput = node.parse
              ? await node.parse(isolatedPrompt.rawText, context)
              : isolatedPrompt.rawText;
          } catch (error) {
            throw attachStepTrace(error, trace);
          }
          return {
            output: parsedOutput,
            promptText,
            rawText: isolatedPrompt.rawText,
            sessionInfo: isolatedBinding,
            agentInfo,
            trace,
          };
        }

        boundSession = await this.ensureSessionBinding(
          runDir,
          state,
          flow,
          node,
          agentInfo,
          nodeTimeoutMs,
        );
        await this.store.appendTrace(runDir, state, {
          scope: "acp",
          type: "acp_prompt_prepared",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          sessionId: boundSession.bundleId,
          payload: {
            sessionId: boundSession.bundleId,
            promptArtifact,
          },
        });
        const persistentPrompt = await this.runPersistentPrompt(
          runDir,
          state,
          boundSession,
          prompt,
          nodeTimeoutMs,
        );
        const rawResponseArtifact = await this.store.writeArtifact(
          runDir,
          state,
          persistentPrompt.rawText,
          {
            mediaType: "text/plain",
            extension: "txt",
            nodeId: state.currentNode,
            attemptId: state.currentAttemptId,
            sessionId: persistentPrompt.sessionInfo.bundleId,
          },
        );
        await this.store.appendTrace(runDir, state, {
          scope: "acp",
          type: "acp_response_parsed",
          nodeId: state.currentNode,
          attemptId: state.currentAttemptId,
          sessionId: persistentPrompt.sessionInfo.bundleId,
          payload: {
            sessionId: persistentPrompt.sessionInfo.bundleId,
            conversation: persistentPrompt.conversation,
            rawResponseArtifact,
          },
        });
        const trace: FlowStepTrace = {
          sessionId: persistentPrompt.sessionInfo.bundleId,
          promptArtifact,
          rawResponseArtifact,
          conversation: persistentPrompt.conversation,
        };
        let parsedOutput: unknown;
        try {
          parsedOutput = node.parse
            ? await node.parse(persistentPrompt.rawText, context)
            : persistentPrompt.rawText;
        } catch (error) {
          throw attachStepTrace(error, trace);
        }
        return {
          output: parsedOutput,
          promptText,
          rawText: persistentPrompt.rawText,
          sessionInfo: persistentPrompt.sessionInfo,
          agentInfo,
          trace,
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
    attemptId: string,
    nodeType: FlowNodeDefinition["nodeType"],
    startedAt: string,
    detail?: string,
  ): void {
    state.status = "running";
    state.waitingOn = undefined;
    state.currentNode = nodeId;
    state.currentAttemptId = attemptId;
    state.currentNodeType = nodeType;
    state.currentNodeStartedAt = startedAt;
    state.lastHeartbeatAt = startedAt;
    state.statusDetail = detail ?? `Running ${nodeType} node ${nodeId}`;
  }

  private clearActiveNode(state: FlowRunState, detail?: string): void {
    state.currentNode = undefined;
    state.currentAttemptId = undefined;
    state.currentNodeType = undefined;
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

  private async finalizeStepTrace(
    runDir: string,
    state: FlowRunState,
    nodeId: string,
    attemptId: string,
    output: unknown,
    baseTrace: FlowStepTrace | null,
  ): Promise<FlowStepTrace | null> {
    const trace: FlowStepTrace = baseTrace ? structuredClone(baseTrace) : {};
    if (output !== undefined) {
      const inlineOutput = toInlineOutput(output);
      if (inlineOutput !== undefined) {
        trace.outputInline = inlineOutput;
      } else {
        trace.outputArtifact = await this.store.writeArtifact(runDir, state, output, {
          mediaType: outputArtifactMediaType(output),
          extension: outputArtifactExtension(output),
          nodeId,
          attemptId,
        });
      }
    }
    return Object.keys(trace).length > 0 ? trace : null;
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
      bundleId: createSessionBundleId(handle, key),
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
    await this.store.ensureSessionBundle(runDir, state, binding, created);
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

    await sendSessionDirect({
      sessionId: binding.acpxRecordId,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
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

function createSessionBundleId(handle: string, key: string): string {
  const safeHandle = handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${safeHandle || "session"}-${stableShortHash(key)}`;
}

function createIsolatedSessionBinding(
  flowName: string,
  runId: string,
  attemptId: string,
  profile: string | undefined,
  agent: ResolvedFlowAgent,
): FlowSessionBinding {
  const key = `isolated::${attemptId}`;
  const handle = "isolated";
  return {
    key,
    handle,
    bundleId: createSessionBundleId(`${handle}-${attemptId}`, `${key}::${agent.cwd}`),
    name: `${flowName}-${attemptId}-${runId.slice(-8)}`,
    profile,
    agentName: agent.agentName,
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    acpxRecordId: key,
    acpSessionId: key,
  };
}

function createSyntheticSessionRecord(options: {
  binding: FlowSessionBinding;
  createdAt: string;
  updatedAt: string;
  conversation: ReturnType<typeof createSessionConversation>;
  acpxState: SessionRecord["acpx"] | undefined;
  lastSeq: number;
}): SessionRecord {
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: options.binding.acpxRecordId,
    acpSessionId: options.binding.acpSessionId,
    agentSessionId: options.binding.agentSessionId,
    agentCommand: options.binding.agentCommand,
    cwd: options.binding.cwd,
    name: options.binding.name,
    createdAt: options.createdAt,
    lastUsedAt: options.updatedAt,
    lastSeq: options.lastSeq,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(options.binding.acpxRecordId),
    closed: true,
    closedAt: options.updatedAt,
    title: options.conversation.title,
    messages: options.conversation.messages,
    updated_at: options.conversation.updated_at,
    cumulative_token_usage: options.conversation.cumulative_token_usage,
    request_token_usage: options.conversation.request_token_usage,
    acpx: options.acpxState,
  };
}

function createNodeResult(options: {
  attemptId: string;
  nodeId: string;
  nodeType: FlowNodeDefinition["nodeType"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
}): FlowNodeResult {
  return {
    attemptId: options.attemptId,
    nodeId: options.nodeId,
    nodeType: options.nodeType,
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

function nextAttemptId(attemptCounts: Map<string, number>, nodeId: string): string {
  const next = (attemptCounts.get(nodeId) ?? 0) + 1;
  attemptCounts.set(nodeId, next);
  return `${nodeId}#${next}`;
}

function createNodeOutcomePayload(
  result: FlowNodeResult,
  trace: FlowStepTrace | null,
): Record<string, unknown> {
  return {
    nodeType: result.nodeType,
    outcome: result.outcome,
    durationMs: result.durationMs,
    error: result.error ?? null,
    ...trace,
  };
}

function attachStepTrace(error: unknown, trace: FlowStepTrace | null): Error {
  const attached =
    error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  (attached as Error & { flowStepTrace?: FlowStepTrace | null }).flowStepTrace = trace;
  return attached;
}

function extractAttachedStepTrace(error: unknown): FlowStepTrace | null | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as Error & { flowStepTrace?: FlowStepTrace | null }).flowStepTrace;
}

function toInlineOutput(value: unknown): undefined | null | boolean | number | string | object {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 200 && !value.includes("\n") ? value : undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 200 && !serialized.includes("\n")) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function outputArtifactMediaType(value: unknown): string {
  return typeof value === "string" ? "text/plain" : "application/json";
}

function outputArtifactExtension(value: unknown): string {
  return typeof value === "string" ? "txt" : "json";
}

function findConversationDeltaStart(
  before: SessionRecord["messages"],
  after: SessionRecord["messages"],
): number {
  const maxOverlap = Math.min(before.length, after.length);
  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      const beforeMessage = before[before.length - overlap + index];
      const afterMessage = after[index];
      if (!deepEqualJson(beforeMessage, afterMessage)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return overlap;
    }
  }
  return 0;
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isoNow(): string {
  return new Date().toISOString();
}
