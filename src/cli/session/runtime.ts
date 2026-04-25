import { AcpClient } from "../../acp/client.js";
import {
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import { InterruptedError, withInterrupt, withTimeout } from "../../async-control.js";
export { InterruptedError, TimeoutError } from "../../async-control.js";
import { formatPerfMetric, measurePerf, startPerfTimer } from "../../perf-metrics.js";
import { textPrompt } from "../../prompt-content.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
} from "../../runtime/engine/lifecycle.js";
import { runPromptTurn } from "../../runtime/engine/prompt-turn.js";
import { connectAndLoadSession } from "../../runtime/engine/reconnect.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "../../runtime/engine/session-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { SessionEventWriter } from "../../session/events.js";
import { setCurrentModelId, setDesiredModelId } from "../../session/mode-preference.js";
import { absolutePath, isoNow, resolveSessionRecord } from "../../session/persistence.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  ClientOperation,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  PermissionMode,
  PromptInput,
  RunPromptResult,
  SessionNotification,
  SessionRecord,
  SessionResumePolicy,
  SessionSendResult,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

type RunSessionPromptOptions = {
  sessionRecordId: string;
  prompt: PromptInput;
  resumePolicy?: SessionResumePolicy;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
  client?: AcpClient;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {}

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.send({
      type: "event",
      requestId: this.requestId,
      message,
    });
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  flush(): void {}
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  flush() {},
};

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
  };
}

async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: import("../../acp/client.js").SessionCreateResult["models"];
  timeoutMs?: number;
}): Promise<boolean> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel || !params.models) {
    return false;
  }
  if (params.models.currentModelId === requestedModel) {
    return true;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  return true;
}

async function applyPromptModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<void> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel || !Array.isArray(params.record.acpx?.available_models)) {
    return;
  }
  if (params.record.acpx.current_model_id === requestedModel) {
    setDesiredModelId(params.record, requestedModel);
    return;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  setDesiredModelId(params.record, requestedModel);
  setCurrentModelId(params.record, requestedModel);
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return undefined;
}

function extractJsonRpcRequestInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; method: string } | undefined {
  const candidate = message as { method?: unknown; id?: unknown };
  if (typeof candidate.method !== "string") {
    return undefined;
  }
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  return {
    idKey,
    method: candidate.method,
  };
}

function extractJsonRpcResponseInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; hasError: boolean } | undefined {
  const candidate = message as { id?: unknown; error?: unknown; result?: unknown };
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  const hasError = Object.hasOwn(candidate, "error");
  const hasResult = Object.hasOwn(candidate, "result");
  if (!hasError && !hasResult) {
    return undefined;
  }
  return {
    idKey,
    hasError,
  };
}

function filterRecoverableLoadFallbackOutput(messages: AcpJsonRpcMessage[]): AcpJsonRpcMessage[] {
  const requestMethodById = new Map<string, string>();
  const failedLoadRequestIds = new Set<string>();

  for (const message of messages) {
    const request = extractJsonRpcRequestInfo(message);
    if (request) {
      requestMethodById.set(request.idKey, request.method);
      continue;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (!response || !response.hasError) {
      continue;
    }

    if (requestMethodById.get(response.idKey) === "session/load") {
      failedLoadRequestIds.add(response.idKey);
    }
  }

  if (failedLoadRequestIds.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    const request = extractJsonRpcRequestInfo(message);
    if (request && request.method === "session/load" && failedLoadRequestIds.has(request.idKey)) {
      return false;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (response && failedLoadRequestIds.has(response.idKey)) {
      return false;
    }

    return true;
  });
}

function emitPromptRetryNotice(params: {
  error: unknown;
  delayMs: number;
  attempt: number;
  maxRetries: number;
  suppressSdkConsoleErrors?: boolean;
}): void {
  if (params.suppressSdkConsoleErrors) {
    return;
  }

  process.stderr.write(
    `[acpx] prompt failed (${formatErrorMessage(params.error)}), retrying in ${params.delayMs}ms ` +
      `(attempt ${params.attempt}/${params.maxRetries})\n`,
  );
}

export async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    promptRetries?: number;
    sessionOptions?: SessionAgentOptions;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt({
      sessionRecordId,
      mcpServers: options.mcpServers,
      prompt: task.prompt ?? textPrompt(task.message),
      permissionMode: task.permissionMode,
      resumePolicy: task.resumePolicy,
      nonInteractivePermissions:
        task.nonInteractivePermissions ?? options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      promptRetries: options.promptRetries,
      sessionOptions: mergeSessionOptions(task.sessionOptions, options.sessionOptions),
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptActive: options.onPromptActive,
      client: options.sharedClient,
    });

    if (task.waitForCompletion) {
      task.send({
        type: "result",
        requestId: task.requestId,
        result,
      });
    }
  } catch (error) {
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
    });
    const alreadyEmitted =
      (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
    if (task.waitForCompletion) {
      task.send({
        type: "error",
        requestId: task.requestId,
        code: normalizedError.code,
        detailCode: normalizedError.detailCode,
        origin: normalizedError.origin,
        message: normalizedError.message,
        retryable: normalizedError.retryable,
        acp: normalizedError.acp,
        outputAlreadyEmitted: alreadyEmitted,
      });
    }

    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });
  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  const promptMessageId = recordPromptSubmission(conversation, options.prompt, isoNow());

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: AcpJsonRpcMessage[] = [];
  const sessionOptions = mergeSessionOptions(
    options.sessionOptions,
    sessionOptionsFromRecord(record),
  );
  let bufferingConnectOutput = true;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  let sawAcpMessage = false;
  let eventWriterClosed = false;

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await eventWriter.close({ checkpoint });
  };

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0, pendingMessages.length);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      sessionOptions,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    onAcpMessage: (direction, message) => {
      sawAcpMessage = true;
      pendingMessages.push(message);
      options.onAcpMessage?.(direction, message);
    },
    onAcpOutputMessage: (_direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push(message);
        return;
      }
      output.onAcpMessage(message);
    },
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      trimConversationForRuntime(conversation);
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
      options.onClientOperation?.(operation);
    },
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionModel: async (modelId: string) => {
      await client.setSessionModel(activeSessionIdForControl, modelId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(activeSessionIdForControl, configId, value);
    },
  };

  try {
    return await withInterrupt(
      async () => {
        const connectStartedAt = Date.now();
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await measurePerf("runtime.connect_and_load", async () => {
          try {
            return await connectAndLoadSession({
              client,
              record,
              resumePolicy: options.resumePolicy,
              timeoutMs: options.timeoutMs,
              verbose: options.verbose,
              activeController,
              onClientAvailable: (controller) => {
                options.onClientAvailable?.(controller);
                notifiedClientAvailable = true;
              },
              onConnectedRecord: (connectedRecord) => {
                connectedRecord.lastPromptAt = isoNow();
              },
              onSessionIdResolved: (sessionId) => {
                activeSessionIdForControl = sessionId;
              },
            });
          } catch (error) {
            bufferingConnectOutput = false;
            for (const message of pendingConnectOutputMessages) {
              output.onAcpMessage(message);
            }
            pendingConnectOutputMessages.length = 0;
            throw error;
          }
        });
        bufferingConnectOutput = false;
        const connectOutputMessages =
          loadError == null
            ? pendingConnectOutputMessages
            : filterRecoverableLoadFallbackOutput(pendingConnectOutputMessages);
        for (const message of connectOutputMessages) {
          output.onAcpMessage(message);
        }
        pendingConnectOutputMessages.length = 0;
        if (options.verbose) {
          process.stderr.write(
            `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - connectStartedAt)}\n`,
          );
        }

        await applyPromptModelIfAdvertised({
          client,
          sessionId: activeSessionId,
          requestedModel: sessionOptions?.model,
          record,
          timeoutMs: options.timeoutMs,
        });

        output.setContext({
          sessionId: record.acpxRecordId,
        });
        await flushPendingMessages(false);

        const maxRetries = options.promptRetries ?? 0;
        let response;
        promptTurnActive = true;
        for (let attempt = 0; ; attempt++) {
          try {
            const promptStartedAt = Date.now();
            response = await measurePerf("runtime.prompt.agent_turn", async () => {
              return await runPromptTurn({
                client,
                sessionId: activeSessionId,
                prompt: options.prompt,
                timeoutMs: options.timeoutMs,
                conversation,
                promptMessageId,
                onPromptStarted:
                  attempt === 0 && options.onPromptActive
                    ? async () => {
                        try {
                          await options.onPromptActive?.();
                        } catch (error) {
                          if (options.verbose) {
                            process.stderr.write(
                              "[acpx] onPromptActive hook failed: " +
                                formatErrorMessage(error) +
                                "\n",
                            );
                          }
                        }
                      }
                    : undefined,
              });
            });
            if (options.verbose) {
              process.stderr.write(
                `[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - promptStartedAt)}\n`,
              );
            }
            break;
          } catch (error) {
            const snapshot = client.getAgentLifecycleSnapshot();
            const agentCrashed = snapshot.lastExit?.unexpectedDuringPrompt === true;

            if (
              attempt < maxRetries &&
              !agentCrashed &&
              !promptTurnHadSideEffects &&
              isRetryablePromptError(error)
            ) {
              const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
              emitPromptRetryNotice({
                error,
                delayMs,
                attempt: attempt + 1,
                maxRetries,
                suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
              });
              await waitMs(delayMs);
              if (!promptTurnHadSideEffects) {
                continue;
              }
            }

            promptTurnActive = false;
            applyLifecycleSnapshotToRecord(record, snapshot);
            const lastExit = snapshot.lastExit;
            if (lastExit?.unexpectedDuringPrompt && options.verbose) {
              process.stderr.write(
                "[acpx] agent disconnected during prompt (" +
                  lastExit.reason +
                  ", exit=" +
                  lastExit.exitCode +
                  ", signal=" +
                  (lastExit.signal ?? "none") +
                  ")\n",
              );
            }

            const normalizedError = normalizeOutputError(error, {
              origin: "runtime",
            });

            await flushPendingMessages(false).catch(() => {
              // best effort while bubbling prompt failure
            });

            output.flush();

            record.lastUsedAt = isoNow();
            applyConversation(record, conversation);
            record.acpx = acpxState;

            const propagated =
              error instanceof Error ? error : new Error(formatErrorMessage(error));
            (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
            (propagated as { normalizedOutputError?: unknown }).normalizedOutputError =
              normalizedError;
            throw propagated;
          }
        }
        promptTurnActive = false;

        await flushPendingMessages(false);
        output.flush();

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyConversation(record, conversation);
        record.acpx = acpxState;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        stopTotalTimer();

        return {
          ...toPromptResult(response.stopReason, record.acpxRecordId, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        record.acpx = acpxState;
        await flushPendingMessages(false).catch(() => {
          // best effort while process is being interrupted
        });
        if (ownClient) {
          await client.close();
        }
      },
    );
  } finally {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", stopTotalTimer())}\n`);
    } else {
      stopTotalTimer();
    }
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    client.clearEventHandlers();
    if (ownClient) {
      await client.close();
    }
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await closeEventWriter(true).catch(() => {
      // best effort on close
    });
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpMessage: options.onAcpMessage,
    onAcpOutputMessage: (_direction, message) => output.onAcpMessage(message),
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onClientOperation?.(operation);
    },
    sessionOptions: options.sessionOptions,
  });

  try {
    return await withInterrupt(
      async () => {
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd)),
            options.timeoutMs,
          );
        });
        const sessionId = createdSession.sessionId;
        await applyRequestedModelIfAdvertised({
          client,
          sessionId,
          requestedModel: options.sessionOptions?.model,
          models: createdSession.models,
          timeoutMs: options.timeoutMs,
        });

        output.setContext({
          sessionId,
        });

        const maxRetries = options.promptRetries ?? 0;
        let response;
        promptTurnActive = true;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await measurePerf("runtime.exec.prompt", async () => {
              return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
            });
            break;
          } catch (error) {
            if (
              attempt < maxRetries &&
              !promptTurnHadSideEffects &&
              isRetryablePromptError(error)
            ) {
              const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
              emitPromptRetryNotice({
                error,
                delayMs,
                attempt: attempt + 1,
                maxRetries,
                suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
              });
              await waitMs(delayMs);
              if (!promptTurnHadSideEffects) {
                continue;
              }
            }
            promptTurnActive = false;
            throw error;
          }
        }
        promptTurnActive = false;
        output.flush();
        return toPromptResult(response.stopReason, sessionId, client);
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function sendSessionDirect(options: SessionSendOptions): Promise<SessionSendResult> {
  return await runSessionPrompt({
    sessionRecordId: options.sessionId,
    prompt: options.prompt,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter: options.outputFormatter,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    client: options.client,
  });
}
