import { AcpClient } from "../../acp/client.js";
import {
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import {
  assertRequestedModelSupported,
  modelStateFromConfigOptions,
} from "../../acp/model-support.js";
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
  applyConfigOptionsToRecord,
  applyConfigOptionsToState,
} from "../../session/config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { SessionEventWriter } from "../../session/events.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import {
  clearDesiredConfigOption,
  setCurrentModelId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelIfAdvertised,
  currentModelIdFromSetModelResponse,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import {
  absolutePath,
  isoNow,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import type {
  AcpJsonRpcMessage,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
  OutputFormatter,
  PermissionEscalationEvent,
  PermissionPolicy,
  RunPromptResult,
  SessionAcpxState,
  SessionRecord,
  SessionSendResult,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

type RunSessionPromptOptions = Omit<
  SessionSendOptions,
  "errorEmissionPolicy" | "maxQueueDepth" | "sessionId" | "ttlMs" | "waitForCompletion"
> & {
  sessionRecordId: string;
  handleProcessInterrupts?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
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

  onPermissionEscalation(event: PermissionEscalationEvent): void {
    this.send({
      type: "permission_escalation",
      requestId: this.requestId,
      event,
    });
  }

  flush(): void {}
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
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

function requestedModelId(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function applyConfigOptionResponseToState(
  state: SessionAcpxState | undefined,
  response:
    | Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>
    | Awaited<ReturnType<AcpClient["setSessionModel"]>>,
): SessionAcpxState | undefined {
  if (!response?.configOptions) {
    return state;
  }
  return applyConfigOptionsToState(state, response.configOptions);
}

export function mergeConnectedModelState(
  state: SessionAcpxState | undefined,
  connectedState: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!connectedState) {
    return state;
  }
  const nextState = cloneSessionAcpxState(state) ?? {};
  mergeConnectedAdvertisedModelState(nextState, connectedState);
  mergeConnectedModelPreferences(nextState, connectedState);
  return nextState;
}

function mergeConnectedAdvertisedModelState(
  nextState: SessionAcpxState,
  connectedState: SessionAcpxState,
): void {
  if (connectedState.config_options !== undefined) {
    nextState.config_options = structuredClone(connectedState.config_options);
  } else {
    delete nextState.config_options;
  }
  if (connectedState.current_model_id !== undefined) {
    nextState.current_model_id = connectedState.current_model_id;
  } else {
    delete nextState.current_model_id;
  }
  if (connectedState.available_models) {
    nextState.available_models = [...connectedState.available_models];
  } else {
    delete nextState.available_models;
  }
  if (connectedState.model_control) {
    nextState.model_control = connectedState.model_control;
  } else {
    delete nextState.model_control;
  }
}

function mergeConnectedModelPreferences(
  nextState: SessionAcpxState,
  connectedState: SessionAcpxState,
): void {
  if (connectedState.session_options) {
    nextState.session_options = cloneSessionAcpxState(connectedState)?.session_options;
  }
  if (connectedState.desired_mode_id !== undefined) {
    nextState.desired_mode_id = connectedState.desired_mode_id;
  }
  if (connectedState.desired_config_options) {
    nextState.desired_config_options = { ...connectedState.desired_config_options };
  }
}

async function applyPromptModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  record: SessionRecord;
  timeoutMs?: number;
  suppressWarnings?: boolean;
}): Promise<void> {
  const requestedModel = requestedModelId(params.requestedModel);
  if (!requestedModel) {
    return;
  }

  const models = advertisedModelState(params.record.acpx);
  const warning = assertRequestedModelSupported({
    requestedModel,
    models,
    agentCommand: params.record.agentCommand,
    context: "apply",
  });
  emitModelSupportWarning(warning, params.suppressWarnings);
  if (!models) {
    return;
  }
  if (params.record.acpx?.current_model_id === requestedModel) {
    setDesiredModelId(params.record, requestedModel, models.configId);
    return;
  }

  const response = await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel, models),
    params.timeoutMs,
  );
  applyConfigOptionsToRecord(params.record, response);
  setDesiredModelId(params.record, requestedModel, models.configId);
  setCurrentModelId(params.record, currentModelIdFromSetModelResponse(response, requestedModel));
}

function emitModelSupportWarning(warning: string | undefined, suppressWarnings?: boolean): void {
  if (warning && !suppressWarnings) {
    process.stderr.write(`[acpx] warning: ${warning}\n`);
  }
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

const SESSION_RECONNECT_METHODS = new Set(["session/load", "session/resume"]);

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

    const requestMethod = requestMethodById.get(response.idKey);
    if (requestMethod && SESSION_RECONNECT_METHODS.has(requestMethod)) {
      failedLoadRequestIds.add(response.idKey);
    }
  }

  if (failedLoadRequestIds.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    const request = extractJsonRpcRequestInfo(message);
    if (
      request &&
      SESSION_RECONNECT_METHODS.has(request.method) &&
      failedLoadRequestIds.has(request.idKey)
    ) {
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

function emitConnectPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - startedAt)}\n`,
  );
}

function emitPromptPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(`[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - startedAt)}\n`);
}

function emitPromptHookError(error: unknown, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write("[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n");
}

function emitPromptDisconnectNotice(
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  verbose?: boolean,
): void {
  const lastExit = snapshot.lastExit;
  if (!lastExit?.unexpectedDuringPrompt || !verbose) {
    return;
  }
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

function shouldRetryRuntimePrompt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  hasSideEffects: () => boolean,
): boolean {
  if (!shouldRetryPromptAttempt(error, attempt, maxRetries, hasSideEffects)) {
    return false;
  }
  return snapshot.lastExit?.unexpectedDuringPrompt !== true;
}

function shouldRetryPromptAttempt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  hasSideEffects: () => boolean,
): boolean {
  return attempt < maxRetries && !hasSideEffects() && isRetryablePromptError(error);
}

async function waitBeforePromptRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  suppressSdkConsoleErrors?: boolean,
): Promise<void> {
  const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
  emitPromptRetryNotice({
    error,
    delayMs,
    attempt: attempt + 1,
    maxRetries,
    suppressSdkConsoleErrors,
  });
  await waitMs(delayMs);
}

type QueuedTaskRuntimeOptions = Parameters<typeof runQueuedTask>[2];

function buildQueuedTaskRunOptions(
  sessionRecordId: string,
  task: QueueTask,
  options: QueuedTaskRuntimeOptions,
  outputFormatter: OutputFormatter,
): RunSessionPromptOptions {
  return {
    sessionRecordId,
    mcpServers: options.mcpServers,
    prompt: task.prompt ?? textPrompt(task.message),
    permissionMode: task.permissionMode,
    resumePolicy: task.resumePolicy,
    nonInteractivePermissions: task.nonInteractivePermissions ?? options.nonInteractivePermissions,
    permissionPolicy: task.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter,
    timeoutMs: task.timeoutMs,
    suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    promptRetries: task.promptRetries ?? options.promptRetries ?? 0,
    sessionOptions: mergeSessionOptions(task.sessionOptions, options.sessionOptions),
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    onPromptActive: options.onPromptActive,
    handleProcessInterrupts: options.handleProcessInterrupts,
    client: options.sharedClient,
  };
}

function sendQueuedTaskResult(task: QueueTask, result: SessionSendResult): void {
  if (!task.waitForCompletion) {
    return;
  }
  task.send({
    type: "result",
    requestId: task.requestId,
    result,
  });
}

function sendQueuedTaskError(task: QueueTask, error: unknown): void {
  if (!task.waitForCompletion) {
    return;
  }
  const normalizedError = normalizeOutputError(error, {
    origin: "runtime",
    detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
  });
  const alreadyEmitted =
    (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
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

export async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    permissionPolicy?: PermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    promptRetries?: number;
    sessionOptions?: SessionAgentOptions;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
    handleProcessInterrupts?: boolean;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt(
      buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
    );
    sendQueuedTaskResult(task, result);
  } catch (error) {
    sendQueuedTaskError(task, error);
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
  const promptStartedAt = isoNow();
  const promptMessageId = recordPromptSubmission(conversation, options.prompt, promptStartedAt);
  record.lastPromptAt = promptStartedAt;
  record.lastUsedAt = promptStartedAt;
  applyConversation(record, conversation);
  record.acpx = acpxState;
  await writeSessionRecord(record);

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

    const batch = pendingMessages.splice(0);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };
  const preserveClosedState = async (): Promise<void> => {
    const latest = await resolveSessionRecord(record.acpxRecordId).catch(() => undefined);
    if (!latest?.closed) {
      return;
    }

    record.closed = true;
    record.closedAt = latest.closedAt ?? record.closedAt ?? isoNow();
    record.pid = latest.pid;
    if (latest.acpx) {
      record.acpx = {
        ...record.acpx,
        ...latest.acpx,
      };
    }
  };
  const liveCheckpoint = new LiveSessionCheckpoint({
    save: async () => {
      await flushPendingMessages(false);
      record.lastUsedAt = isoNow();
      applyConversation(record, conversation);
      record.acpx = acpxState;
      await preserveClosedState();
      await eventWriter.checkpoint();
    },
    onError: (error) => {
      if (options.verbose) {
        process.stderr.write(
          "[acpx] live session checkpoint failed: " + formatErrorMessage(error) + "\n",
        );
      }
    },
  });

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      terminal: options.terminal,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      sessionOptions,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    terminal: options.terminal,
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
      liveCheckpoint.request();
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
      liveCheckpoint.request();
      options.onClientOperation?.(operation);
    },
    onPermissionEscalation: (event) => {
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
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
      const models = advertisedModelState(acpxState);
      const response = await client.setSessionModel(activeSessionIdForControl, modelId, models);
      acpxState = applyConfigOptionResponseToState(acpxState, response);
      const nextState = cloneSessionAcpxState(acpxState) ?? {};
      nextState.session_options = { ...nextState.session_options, model: modelId };
      nextState.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
      clearDesiredConfigOption(nextState, models?.configId);
      acpxState = nextState;
      return response;
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      const response = await client.setSessionConfigOption(
        activeSessionIdForControl,
        configId,
        value,
      );
      acpxState = applyConfigOptionResponseToState(acpxState, response);
      const nextState = cloneSessionAcpxState(acpxState) ?? {};
      const modelConfigId = modelStateFromConfigOptions(nextState.config_options)?.configId;
      if (configId === modelConfigId) {
        nextState.session_options = { ...nextState.session_options, model: value };
        nextState.current_model_id = currentModelIdFromSetModelResponse(response, value);
        clearDesiredConfigOption(nextState, configId);
      } else if (configId === "mode") {
        nextState.desired_mode_id = value;
      } else {
        nextState.desired_config_options = {
          ...nextState.desired_config_options,
          [configId]: value,
        };
      }
      acpxState = nextState;
      return response;
    },
  };

  const flushConnectOutput = (loadError?: string): void => {
    bufferingConnectOutput = false;
    const messages =
      loadError == null
        ? pendingConnectOutputMessages
        : filterRecoverableLoadFallbackOutput(pendingConnectOutputMessages);
    for (const message of messages) {
      output.onAcpMessage(message);
    }
    pendingConnectOutputMessages.length = 0;
  };

  const connectForPrompt = async () => {
    const connectStartedAt = Date.now();
    try {
      const connected = await measurePerf("runtime.connect_and_load", async () => {
        return await connectAndLoadSession({
          client,
          record,
          resumePolicy: options.resumePolicy,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          suppressWarnings: options.suppressSdkConsoleErrors,
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
      });
      acpxState = mergeConnectedModelState(acpxState, record.acpx);
      flushConnectOutput(connected.loadError);
      emitConnectPerfMetric(connectStartedAt, options.verbose);
      return connected;
    } catch (error) {
      flushConnectOutput();
      throw error;
    }
  };

  const buildPromptStartedHook = (attempt: number) => {
    if (attempt !== 0 || !options.onPromptActive) {
      return undefined;
    }
    return async () => {
      try {
        await options.onPromptActive?.();
      } catch (error) {
        emitPromptHookError(error, options.verbose);
      }
    };
  };

  const runPromptAttempt = async (sessionId: string, attempt: number) => {
    const promptStartedAt = Date.now();
    const response = await measurePerf("runtime.prompt.agent_turn", async () => {
      return await runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        conversation,
        promptMessageId,
        onPromptStarted: buildPromptStartedHook(attempt),
      });
    });
    emitPromptPerfMetric(promptStartedAt, options.verbose);
    return response;
  };

  const handlePromptFailure = async (error: unknown, attempt: number): Promise<"retry"> => {
    const snapshot = client.getAgentLifecycleSnapshot();
    if (
      shouldRetryRuntimePrompt(
        error,
        attempt,
        options.promptRetries ?? 0,
        snapshot,
        () => promptTurnHadSideEffects,
      )
    ) {
      await waitBeforePromptRetry(
        error,
        attempt,
        options.promptRetries ?? 0,
        options.suppressSdkConsoleErrors,
      );
      return promptTurnHadSideEffects ? await failRuntimePrompt(error, snapshot) : "retry";
    }
    return await failRuntimePrompt(error, snapshot);
  };

  const failRuntimePrompt = async (
    error: unknown,
    snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  ): Promise<never> => {
    promptTurnActive = false;
    applyLifecycleSnapshotToRecord(record, snapshot);
    emitPromptDisconnectNotice(snapshot, options.verbose);
    const normalizedError = normalizeOutputError(error, { origin: "runtime" });
    await flushPendingMessages(false).catch(() => {
      // best effort while bubbling prompt failure
    });
    output.flush();
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    record.acpx = acpxState;
    const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
    (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
    (propagated as { normalizedOutputError?: unknown }).normalizedOutputError = normalizedError;
    throw propagated;
  };

  const runPromptWithRetries = async (sessionId: string) => {
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runPromptAttempt(sessionId, attempt);
      } catch (error) {
        if ((await handlePromptFailure(error, attempt)) === "retry") {
          continue;
        }
      }
    }
  };

  const savePromptSuccess = async (response: Awaited<ReturnType<typeof runPromptTurn>>) => {
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
    return response;
  };

  const runPrompt = async (): Promise<SessionSendResult> => {
    const { sessionId: activeSessionId, resumed, loadError } = await connectForPrompt();

    await applyPromptModelIfAdvertised({
      client,
      sessionId: activeSessionId,
      requestedModel: sessionOptions?.model,
      record,
      timeoutMs: options.timeoutMs,
      suppressWarnings: options.suppressSdkConsoleErrors,
    });
    acpxState = cloneSessionAcpxState(record.acpx);

    output.setContext({
      sessionId: record.acpxRecordId,
    });
    await liveCheckpoint.checkpoint();

    const response = await savePromptSuccess(await runPromptWithRetries(activeSessionId));
    promptTurnActive = false;

    return {
      ...toPromptResult(response.stopReason, record.acpxRecordId, client),
      record,
      resumed,
      loadError,
    };
  };

  const handleInterrupt = async (): Promise<void> => {
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
  };

  try {
    if (options.handleProcessInterrupts === false) {
      return await runPrompt();
    }
    return await withInterrupt(runPrompt, handleInterrupt);
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
    await liveCheckpoint.flush().catch(() => {
      // best effort on close
    });
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await preserveClosedState().catch(() => {
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
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
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
    onPermissionEscalation: (event) => {
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
    },
    sessionOptions: options.sessionOptions,
  });

  const runExecPromptAttempt = async (sessionId: string) => {
    return await measurePerf("runtime.exec.prompt", async () => {
      return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
    });
  };

  const runExecPromptWithRetries = async (sessionId: string) => {
    const maxRetries = options.promptRetries ?? 0;
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runExecPromptAttempt(sessionId);
      } catch (error) {
        if (shouldRetryPromptAttempt(error, attempt, maxRetries, () => promptTurnHadSideEffects)) {
          await waitBeforePromptRetry(error, attempt, maxRetries, options.suppressSdkConsoleErrors);
          if (!promptTurnHadSideEffects) {
            continue;
          }
        }
        promptTurnActive = false;
        throw error;
      }
    }
  };

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
          agentCommand: options.agentCommand,
          timeoutMs: options.timeoutMs,
          onWarning: options.suppressSdkConsoleErrors
            ? undefined
            : (message) => process.stderr.write(`[acpx] warning: ${message}\n`),
        });

        output.setContext({
          sessionId,
        });

        const response = await runExecPromptWithRetries(sessionId);
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
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    outputFormatter: options.outputFormatter,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    onPermissionEscalation: options.onPermissionEscalation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    client: options.client,
  });
}
