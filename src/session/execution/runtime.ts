import { setTimeout as delay } from "node:timers/promises";
import { AcpClient } from "../../acp/client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import {
  assertControlAuthority,
  InterruptedError,
  TimeoutError,
  withInterrupt,
  withTimeout,
} from "../../async-control.js";
import { AcpxOperationalError } from "../../errors.js";
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
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorEmissionPolicy,
  OutputErrorOrigin,
  OutputFormatter,
  PermissionEscalationEvent,
  PermissionPolicy,
  RunPromptResult,
  SessionRecord,
  SessionSendResult,
} from "../../types.js";
import { applyConfigOptionsToState, applyModelSelection } from "../config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../conversation-model.js";
import { SessionEventWriter } from "../events.js";
import type { SessionWatchResult } from "../journal.js";
import { LiveSessionCheckpoint } from "../live-checkpoint.js";
import { applyRequestedModelIfAdvertised } from "../model-application.js";
import { advertisedModelState, applyAdvertisedModelState } from "../model-state.js";
import { absolutePath, isoNow, resolveSessionRecord, writeSessionRecord } from "../persistence.js";
import { type QueueOwnerMessage, type QueueTask } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import { acquireSessionTurn } from "../turn-ownership.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";
import {
  directExecutionError,
  ownDirectClient,
  type DirectExecutionControl,
} from "./direct-lifetime.js";
import { DISCARD_OUTPUT_FORMATTER } from "./discard-output.js";
import { createOwnedSessionControls } from "./owned-controls.js";

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

type RunSessionPromptOptions = Omit<
  SessionSendOptions,
  "maxQueueDepth" | "sessionId" | "ttlMs" | "waitForCompletion"
> & {
  sessionRecordId: string;
  waitSignal?: AbortSignal;
  ownedSignal?: AbortSignal;
  closeProvidedClient?: () => Promise<void>;
  handleProcessInterrupts?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onClientCloseFailure?: () => void;
  onPromptActive?: () => Promise<void> | void;
  onPromptFinalizing?: () => Promise<void>;
  onPromptRequestWritten?: () => Promise<void> | void;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

type BufferedAcpOutputMessage = {
  direction: AcpMessageDirection;
  message: AcpJsonRpcMessage;
};

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

function markOutputAlreadyEmitted(error: unknown, outputAlreadyEmitted: boolean): void {
  if (!outputAlreadyEmitted || !error || typeof error !== "object") {
    return;
  }
  (error as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = true;
}

async function runWithOptionalInterrupt<T>(options: {
  handleProcessInterrupts?: boolean;
  run: () => Promise<T>;
  handleInterrupt: () => Promise<void>;
}): Promise<T> {
  if (options.handleProcessInterrupts === false) {
    return await options.run();
  }
  return await withInterrupt(options.run, options.handleInterrupt);
}

function attachAcpErrorPayload(error: unknown, acp: OutputErrorAcpPayload | undefined): void {
  if (!acp || !error || typeof error !== "object") {
    return;
  }
  (error as { acp?: OutputErrorAcpPayload }).acp = acp;
}

function rendersAcpErrors(policy: OutputErrorEmissionPolicy | undefined): boolean {
  return policy?.queueErrorAlreadyEmitted ?? true;
}

function normalizedErrorText(value: string): string {
  return value.trim().toLowerCase();
}

function outboundAcpErrorMatches(error: unknown, acp: OutputErrorAcpPayload): boolean {
  const errorText = normalizedErrorText(formatErrorMessage(error));
  const details = (acp.data as { details?: unknown } | undefined)?.details;
  const candidate =
    typeof details === "string" && details.trim().length > 0 ? details : acp.message;
  const candidateText = normalizedErrorText(candidate);
  return errorText === candidateText || errorText.includes(candidateText);
}

class AcpErrorTracker {
  private latestInbound: OutputErrorAcpPayload | undefined;
  private readonly outbound: OutputErrorAcpPayload[] = [];

  reset(): void {
    this.latestInbound = undefined;
    this.outbound.length = 0;
  }

  observe(
    output: OutputFormatter,
    direction: AcpMessageDirection,
    message: AcpJsonRpcMessage,
  ): void {
    output.onAcpMessage(message);
    const acp = extractAcpError(message);
    if (!acp) {
      return;
    }
    if (direction === "inbound") {
      this.latestInbound = acp;
      return;
    }
    this.outbound.push(acp);
  }

  match(error: unknown): OutputErrorAcpPayload | undefined {
    return (
      this.latestInbound ?? this.outbound.findLast((acp) => outboundAcpErrorMatches(error, acp))
    );
  }
}

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
  meta?: Record<string, unknown> | null,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function requestedModelId(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

async function applyPromptModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  record: SessionRecord;
  timeoutMs?: number;
  suppressWarnings?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const requestedModel = requestedModelId(params.requestedModel);
  if (!requestedModel) {
    return;
  }

  const result = await applyRequestedModelIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel,
    models: advertisedModelState(params.record.acpx),
    agentCommand: params.record.agentCommand,
    timeoutMs: params.timeoutMs,
    authority: { signal: params.signal },
    onWarning: params.suppressWarnings
      ? undefined
      : (message) => process.stderr.write(`[acpx] warning: ${message}\n`),
  });
  if (result.applied) {
    params.record.acpx = applyModelSelection(params.record.acpx, requestedModel, result.response);
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

function filterBufferedConnectOutput(
  messages: BufferedAcpOutputMessage[],
  loadError: string | undefined,
): BufferedAcpOutputMessage[] {
  if (loadError == null) {
    return messages;
  }
  const filteredMessages = new Set(
    filterRecoverableLoadFallbackOutput(messages.map(({ message }) => message)),
  );
  return messages.filter(({ message }) => filteredMessages.has(message));
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

async function preparePromptRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  hasSideEffects: () => boolean,
  suppressSdkConsoleErrors?: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (attempt < maxRetries && !hasSideEffects() && isRetryablePromptError(error)) {
    signal?.throwIfAborted();
    const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
    emitPromptRetryNotice({
      error,
      delayMs,
      attempt: attempt + 1,
      maxRetries,
      suppressSdkConsoleErrors,
    });
    await delay(delayMs, undefined, { signal }).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    });
    signal?.throwIfAborted();
    return !hasSideEffects();
  }
  return false;
}

function isTurnCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true && error === signal.reason;
}

type PromptOutcome = Pick<RunPromptResult, "stopReason" | "_meta">;

type QueuedTaskRuntimeOptions = Parameters<typeof runQueuedTask>[2];

function buildQueuedTaskRunOptions(
  sessionRecordId: string,
  task: QueueTask,
  options: QueuedTaskRuntimeOptions,
  outputFormatter: OutputFormatter,
): RunSessionPromptOptions {
  return {
    sessionRecordId,
    requestId: task.requestId,
    mcpServers: options.mcpServers,
    prompt: task.prompt ?? textPrompt(task.message),
    permissionMode: task.permissionMode,
    resumePolicy: task.resumePolicy,
    nonInteractivePermissions: task.nonInteractivePermissions ?? options.nonInteractivePermissions,
    permissionPolicy: task.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter,
    errorEmissionPolicy: { queueErrorAlreadyEmitted: true },
    timeoutMs: task.timeoutMs,
    suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    promptRetries: task.promptRetries ?? options.promptRetries ?? 0,
    sessionOptions: mergeSessionOptions(task.sessionOptions, options.sessionOptions),
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    onClientCloseFailure: options.onClientCloseFailure,
    onPromptActive: options.onPromptActive,
    onPromptFinalizing: options.onPromptFinalizing,
    onPromptRequestWritten: () => {
      if (task.reportPromptStarted) {
        task.send({ type: "prompt_started", requestId: task.requestId });
      }
    },
    handleProcessInterrupts: options.handleProcessInterrupts,
    waitSignal: options.waitSignal,
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
    onClientCloseFailure?: () => void;
    onPromptActive?: () => Promise<void> | void;
    onPromptFinalizing?: () => Promise<void>;
    handleProcessInterrupts?: boolean;
    waitSignal?: AbortSignal;
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

async function waitForSessionTurn(options: RunSessionPromptOptions): Promise<{
  recordId: string;
  ownership: AsyncDisposable;
}> {
  const waiting = new AbortController();
  const onInterrupt = () => waiting.abort(new InterruptedError());
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  if (options.handleProcessInterrupts !== false) {
    for (const signal of signals) {
      process.once(signal, onInterrupt);
    }
  }
  const timeoutMs = options.timeoutMs;
  const timeout =
    timeoutMs != null && timeoutMs > 0
      ? setTimeout(() => waiting.abort(new TimeoutError(timeoutMs)), timeoutMs)
      : undefined;
  const signal = options.waitSignal
    ? AbortSignal.any([waiting.signal, options.waitSignal])
    : waiting.signal;
  try {
    // Resolve aliases for the lock key only; read the authoritative record again after admission.
    const { acpxRecordId } = await resolveSessionRecord(options.sessionRecordId);
    const ownership = await acquireSessionTurn(acpxRecordId, signal);
    return { recordId: acpxRecordId, ownership };
  } catch (error) {
    return throwTurnAcquisitionError(error, signal);
  } finally {
    clearTimeout(timeout);
    for (const signal of signals) {
      process.off(signal, onInterrupt);
    }
  }
}

function throwTurnAcquisitionError(error: unknown, signal: AbortSignal): never {
  if (
    signal.aborted &&
    error instanceof Error &&
    error.name === "AbortError" &&
    error.cause === signal.reason
  ) {
    throw signal.reason;
  }
  // Aggregate acquisition/cleanup failures must not be replaced by the abort reason.
  throw error;
}

async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  let turn: Awaited<ReturnType<typeof waitForSessionTurn>>;
  try {
    turn = await waitForSessionTurn(options);
  } catch (error) {
    if (options.ownedSignal) {
      throw error;
    }
    if (options.waitSignal?.aborted && error === options.waitSignal.reason) {
      const record = await resolveSessionRecord(options.sessionRecordId);
      return {
        sessionId: record.acpxRecordId,
        stopReason: "cancelled",
        permissionStats: { requested: 0, approved: 0, denied: 0, cancelled: 0 },
        record,
        resumed: false,
      };
    }
    throw error;
  }
  try {
    return await runOwnedSessionPrompt({ ...options, sessionRecordId: turn.recordId });
  } finally {
    await turn.ownership[Symbol.asyncDispose]();
  }
}

function preparePromptConversation(record: SessionRecord, options: RunSessionPromptOptions) {
  const conversation = cloneSessionConversation(record);
  record.acpx = cloneSessionAcpxState(record.acpx);
  const promptStartedAt = isoNow();
  const promptMessageId = recordPromptSubmission(conversation, options.prompt, promptStartedAt);
  record.lastPromptAt = promptStartedAt;
  record.lastUsedAt = promptStartedAt;
  if (options.requestId !== undefined) {
    record.lastRequestId = options.requestId;
  }
  applyConversation(record, conversation);
  return { conversation, promptMessageId };
}

function failedWatchResult(error: unknown): SessionWatchResult {
  const { message, code, detailCode, retryable } = normalizeOutputError(error, {
    origin: "runtime",
    detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
  });
  return { status: "failed", error: { message, code, detailCode, retryable } };
}

async function writeTurnMarker(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new AcpxOperationalError(`Session journal write failed: ${formatErrorMessage(error)}`, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_JOURNAL_WRITE_FAILED",
      origin: "runtime",
      retryable: false,
      cause: error,
    });
  }
}

type SettledOperation<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown };

async function settleOperation<T>(run: () => T | Promise<T>): Promise<SettledOperation<T>> {
  try {
    return { status: "fulfilled", value: await run() };
  } catch (error) {
    return { status: "rejected", error };
  }
}

function settledWatchResult(outcome: SettledOperation<SessionSendResult>): SessionWatchResult {
  if (outcome.status === "rejected") {
    return failedWatchResult(outcome.error);
  }
  const result = outcome.value;
  return {
    status: result.stopReason === "cancelled" ? "cancelled" : "completed",
    stopReason: result.stopReason,
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
  };
}

async function runFinalizedSessionPrompt(options: {
  writer: SessionEventWriter;
  requestId?: string;
  run: () => Promise<SessionSendResult>;
  cleanup: (attempt: SettledOperation<SessionSendResult>) => Promise<void>;
}): Promise<SessionSendResult> {
  let journalStarted = false;
  const attempt = await settleOperation(async () => {
    const requestId = options.requestId;
    if (requestId !== undefined) {
      await writeTurnMarker(() => options.writer.beginTurn(requestId));
      journalStarted = true;
    }
    return await options.run();
  });
  const cleanup = await settleOperation(() => options.cleanup(attempt));
  // Cleanup failure changes the actual outcome even after an ACP success response.
  const outcome = cleanup.status === "rejected" ? cleanup : attempt;
  const journal = await settleOperation(async () => {
    const requestId = options.requestId;
    if (journalStarted && requestId !== undefined) {
      await writeTurnMarker(() =>
        options.writer.finishTurn(requestId, settledWatchResult(outcome)),
      );
    }
  });
  const closing = await settleOperation(() =>
    writeTurnMarker(() => options.writer.close({ checkpoint: false })),
  );
  if (journal.status === "rejected") {
    throw journal.error;
  }
  if (outcome.status === "rejected") {
    throw outcome.error;
  }
  if (closing.status === "rejected") {
    throw closing.error;
  }
  return outcome.value;
}

async function runOwnedSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });
  options.ownedSignal?.throwIfAborted();
  const { conversation, promptMessageId } = preparePromptConversation(record, options);
  await writeSessionRecord(record);
  options.ownedSignal?.throwIfAborted();

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: BufferedAcpOutputMessage[] = [];
  const sessionOptions = mergeSessionOptions(
    options.sessionOptions,
    sessionOptionsFromRecord(record),
  );
  let bufferingConnectOutput = true;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  const acpErrors = new AcpErrorTracker();

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
    if (options.requestId !== undefined) {
      record.lastRequestId = options.requestId;
    }
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

  let closeClientOnExit = options.client == null || options.ownedSignal !== undefined;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      terminal: options.terminal,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      sessionOptions,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    fs: options.fs,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  const closeOwnedClient =
    options.closeProvidedClient ?? ownDirectClient(client, options.ownedSignal);
  client.setEventHandlers({
    onAcpMessage: (direction, message) => {
      pendingMessages.push(message);
      options.onAcpMessage?.(direction, message);
    },
    onAcpOutputMessage: (direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push({ direction, message });
        return;
      }
      acpErrors.observe(output, direction, message);
    },
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      record.acpx = recordConversationSessionUpdate(conversation, record.acpx, notification);
      trimConversationForRuntime(conversation);
      liveCheckpoint.request();
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      record.acpx = recordConversationClientOperation(conversation, record.acpx, operation);
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
  let controlRetirement: Promise<void> | undefined;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    ...createOwnedSessionControls({
      client,
      record,
      sessionId: () => activeSessionIdForControl,
      checkpoint: () => liveCheckpoint.checkpoint(),
      retire: () => {
        controlRetirement ??= client.close().catch((error: unknown) => {
          options.onClientCloseFailure?.();
          throw error;
        });
        return controlRetirement;
      },
    }),
  };

  const flushConnectOutput = (loadError?: string): void => {
    bufferingConnectOutput = false;
    const outputMessages = filterBufferedConnectOutput(pendingConnectOutputMessages, loadError);
    for (const { direction, message } of outputMessages) {
      acpErrors.observe(output, direction, message);
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
          replacingConfigOption: requestedModelId(options.sessionOptions?.model)
            ? { key: "model" }
            : undefined,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          suppressWarnings: options.suppressSdkConsoleErrors,
          activeController,
          authority: { signal: options.ownedSignal },
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
      flushConnectOutput(connected.loadError);
      emitConnectPerfMetric(connectStartedAt, options.verbose);
      return connected;
    } catch (error) {
      // A shared queue client must reconnect after an incomplete preference replay.
      closeClientOnExit = true;
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
    acpErrors.reset();
    const promptStartedAt = Date.now();
    const response = await measurePerf("runtime.prompt.agent_turn", async () => {
      return await runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        conversation,
        promptMessageId,
        onPromptRequestWritten: options.onPromptRequestWritten,
        onPromptStarted: buildPromptStartedHook(attempt),
        authority: { signal: options.waitSignal },
      });
    });
    emitPromptPerfMetric(promptStartedAt, options.verbose);
    return response;
  };

  const handlePromptFailure = async (error: unknown, attempt: number): Promise<void> => {
    if (isTurnCancellation(error, options.waitSignal)) {
      throw error;
    }
    const snapshot = client.getAgentLifecycleSnapshot();
    if (
      snapshot.lastExit?.unexpectedDuringPrompt !== true &&
      (await preparePromptRetry(
        error,
        attempt,
        options.promptRetries ?? 0,
        () => promptTurnHadSideEffects,
        options.suppressSdkConsoleErrors,
        options.waitSignal,
      ))
    ) {
      return;
    }
    await failRuntimePrompt(error, snapshot);
  };

  const failRuntimePrompt = async (
    error: unknown,
    snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  ): Promise<never> => {
    promptTurnActive = false;
    applyLifecycleSnapshotToRecord(record, snapshot);
    emitPromptDisconnectNotice(snapshot, options.verbose);
    const matchedAcpError = acpErrors.match(error);
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      acp: matchedAcpError,
    });
    await flushPendingMessages(false).catch(() => {
      // best effort while bubbling prompt failure
    });
    output.flush();
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
    attachAcpErrorPayload(propagated, normalizedError.acp);
    (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted =
      matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted;
    (propagated as { normalizedOutputError?: unknown }).normalizedOutputError = normalizedError;
    throw propagated;
  };

  const runPromptWithRetries = async (sessionId: string): Promise<PromptOutcome> => {
    promptTurnActive = true;
    try {
      for (let attempt = 0; ; attempt++) {
        options.waitSignal?.throwIfAborted();
        try {
          return await runPromptAttempt(sessionId, attempt);
        } catch (error) {
          await handlePromptFailure(error, attempt);
        }
      }
    } catch (error) {
      if (isTurnCancellation(error, options.waitSignal)) {
        return { stopReason: "cancelled" };
      }
      throw error;
    }
  };

  const savePromptSuccess = async (response: PromptOutcome) => {
    await flushPendingMessages(false);
    output.flush();
    const now = isoNow();
    record.lastUsedAt = now;
    record.closed = false;
    record.closedAt = undefined;
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
    applyConversation(record, conversation);
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    stopTotalTimer();
    return response;
  };

  const runPrompt = async (): Promise<SessionSendResult> => {
    options.ownedSignal?.throwIfAborted();
    const { sessionId: activeSessionId, resumed, loadError } = await connectForPrompt();
    options.ownedSignal?.throwIfAborted();

    await applyPromptModelIfAdvertised({
      client,
      sessionId: activeSessionId,
      requestedModel: options.sessionOptions?.model,
      record,
      timeoutMs: options.timeoutMs,
      suppressWarnings: options.suppressSdkConsoleErrors,
      signal: options.ownedSignal,
    });
    options.ownedSignal?.throwIfAborted();

    output.setContext({
      sessionId: record.acpxRecordId,
    });
    await liveCheckpoint.checkpoint();

    const response = await savePromptSuccess(await runPromptWithRetries(activeSessionId));
    promptTurnActive = false;

    return {
      ...toPromptResult(response.stopReason, record.acpxRecordId, client, response._meta),
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
    await flushPendingMessages(false).catch(() => {
      // best effort while process is being interrupted
    });
    if (closeClientOnExit) {
      await closeOwnedClient();
    }
  };

  const runObservedPrompt = async (): Promise<SessionSendResult> => {
    try {
      const result = await runWithOptionalInterrupt({
        handleProcessInterrupts: options.handleProcessInterrupts,
        run: runPrompt,
        handleInterrupt,
      });
      options.ownedSignal?.throwIfAborted();
      return result;
    } catch (error) {
      const failure = directExecutionError(error, options.ownedSignal);
      const matchedAcpError = acpErrors.match(failure);
      attachAcpErrorPayload(failure, matchedAcpError);
      markOutputAlreadyEmitted(
        failure,
        matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted,
      );
      throw failure;
    }
  };

  const cleanupPrompt = async (attempt: SettledOperation<SessionSendResult>): Promise<void> => {
    const controlDrain = options.onPromptFinalizing?.();
    const unresolvedPrompt = client.hasUnresolvedPrompt();
    const steps = [
      async () => {
        if (unresolvedPrompt) {
          await withTimeout(
            client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS),
            INTERRUPT_CANCEL_WAIT_MS,
          ).catch(() => {
            // A stalled cancellation write must not prevent connection retirement.
          });
        }
      },
      async () => {
        const journalFailed =
          attempt.status === "rejected" &&
          attempt.error instanceof AcpxOperationalError &&
          attempt.error.detailCode === "SESSION_JOURNAL_WRITE_FAILED";
        if (unresolvedPrompt || closeClientOnExit || journalFailed) {
          try {
            // Keep the old turn's handlers and ownership until teardown completes.
            await closeOwnedClient();
          } catch (error) {
            options.onClientCloseFailure?.();
            throw error;
          }
        }
      },
      async () => {
        await controlDrain;
      },
      () => {
        const duration = stopTotalTimer();
        if (options.verbose) {
          process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", duration)}\n`);
        }
      },
      () => {
        if (notifiedClientAvailable) {
          options.onClientClosed?.();
        }
      },
      () => client.clearEventHandlers(),
      () => applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot()),
      () => applyConversation(record, conversation),
    ];
    const outcomes: SettledOperation<void>[] = [];
    for (const step of steps) {
      outcomes.push(await settleOperation(step));
    }
    // Checkpoint failures remain best effort; an append failure is reported by finishTurn.
    for (const checkpoint of [
      () => liveCheckpoint.flush(),
      () => flushPendingMessages(false),
      preserveClosedState,
      () => eventWriter.checkpoint(),
    ]) {
      await settleOperation(checkpoint);
    }
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) {
      throw failure.error;
    }
  };

  return await runFinalizedSessionPrompt({
    writer: eventWriter,
    requestId: options.requestId,
    run: runObservedPrompt,
    cleanup: cleanupPrompt,
  });
}

export async function runOnce(
  options: RunOnceOptions,
  control?: DirectExecutionControl,
): Promise<RunPromptResult> {
  const authority = { signal: control?.signal };
  const output = options.outputFormatter;
  const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  let controlState: NonNullable<SessionRecord["acpx"]> = {};
  const acpErrors = new AcpErrorTracker();
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpMessage: options.onAcpMessage,
    onAcpOutputMessage: (direction, message) => {
      acpErrors.observe(output, direction, message);
    },
    onSessionUpdate: (notification) => {
      if (notification.update.sessionUpdate === "config_option_update") {
        controlState = applyConfigOptionsToState(controlState, notification.update.configOptions);
      }
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

  const closeOwnedClient = ownDirectClient(client, control?.signal);

  const runExecPromptAttempt = async (sessionId: string) => {
    assertControlAuthority(authority);
    acpErrors.reset();
    return await measurePerf("runtime.exec.prompt", async () => {
      return await withTimeout(
        client.prompt(sessionId, options.prompt, undefined, undefined, undefined, {
          signal: control?.signal,
        }),
        options.timeoutMs,
      );
    });
  };

  const runExecPromptWithRetries = async (sessionId: string) => {
    const maxRetries = options.promptRetries ?? 0;
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runExecPromptAttempt(sessionId);
      } catch (error) {
        if (
          await preparePromptRetry(
            error,
            attempt,
            maxRetries,
            () => promptTurnHadSideEffects,
            options.suppressSdkConsoleErrors,
            control?.signal,
          )
        ) {
          continue;
        }
        promptTurnActive = false;
        throw error;
      }
    }
  };

  try {
    return await runWithOptionalInterrupt({
      handleProcessInterrupts: control?.handleProcessInterrupts,
      run: async () => {
        assertControlAuthority(authority);
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(authority), options.timeoutMs);
        });
        assertControlAuthority(authority);
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd), authority),
            options.timeoutMs,
          );
        });
        assertControlAuthority(authority);
        const sessionId = createdSession.sessionId;
        if (createdSession.models) {
          applyAdvertisedModelState(controlState, createdSession.models);
        }
        controlState = applyConfigOptionsToState(controlState, createdSession.configOptions ?? []);
        const modelApplication = await applyRequestedModelIfAdvertised({
          client,
          sessionId,
          requestedModel: options.sessionOptions?.model,
          models: createdSession.models,
          agentCommand: options.agentCommand,
          timeoutMs: options.timeoutMs,
          authority: authority,
          onWarning: options.suppressSdkConsoleErrors
            ? undefined
            : (message) => process.stderr.write(`[acpx] warning: ${message}\n`),
        });
        if (modelApplication.response) {
          controlState = applyConfigOptionsToState(
            controlState,
            modelApplication.response.configOptions,
          );
        }
        for (const configOption of options.configOptions ?? []) {
          assertControlAuthority(authority);
          const response = await withTimeout(
            client.setSessionConfigOption(
              sessionId,
              configOption.configId,
              configOption.value,
              advertisedModelState(controlState),
              authority,
            ),
            options.timeoutMs,
          );
          controlState = applyConfigOptionsToState(controlState, response.configOptions);
        }

        assertControlAuthority(authority);
        output.setContext({
          sessionId,
        });

        const response = await runExecPromptWithRetries(sessionId);
        promptTurnActive = false;
        return toPromptResult(response.stopReason, sessionId, client, response._meta);
      },
      handleInterrupt: async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        await closeOwnedClient();
      },
    });
  } catch (error) {
    const failure = directExecutionError(error, authority.signal);
    const matchedAcpError = acpErrors.match(failure);
    attachAcpErrorPayload(failure, matchedAcpError);
    markOutputAlreadyEmitted(failure, matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted);
    throw failure;
  } finally {
    try {
      await closeOwnedClient();
    } finally {
      try {
        options.onPermissionStats?.(client.getPermissionStats());
      } catch {
        // Accounting observers must not replace execution or cleanup outcomes.
      }
      output.flush();
    }
  }
}

export async function sendSessionDirect(
  options: SessionSendOptions,
  control?: DirectExecutionControl,
): Promise<SessionSendResult> {
  const closeProvidedClient =
    control && options.client ? ownDirectClient(options.client, control.signal) : undefined;
  try {
    control?.signal.throwIfAborted();
    return await runSessionPrompt({
      ownedSignal: control?.signal,
      closeProvidedClient,
      waitSignal: control?.signal,
      handleProcessInterrupts: control?.handleProcessInterrupts,
      sessionRecordId: options.sessionId,
      prompt: options.prompt,
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      resumePolicy: options.resumePolicy,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      terminal: options.terminal,
      outputFormatter: options.outputFormatter,
      errorEmissionPolicy: options.errorEmissionPolicy,
      onAcpMessage: options.onAcpMessage,
      onSessionUpdate: options.onSessionUpdate,
      onClientOperation: options.onClientOperation,
      onPermissionEscalation: options.onPermissionEscalation,
      timeoutMs: options.timeoutMs,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      client: options.client,
    });
  } finally {
    // A provided initial client is owned even if cancellation wins before turn admission.
    await closeProvidedClient?.();
  }
}
