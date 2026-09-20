import { randomUUID } from "node:crypto";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError, QueueProtocolError } from "../../errors.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  PermissionPolicy,
  PromptInput,
  SessionResumePolicy,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "../../types.js";
import { probeQueueOwnerHealth, type QueueOwnerHealth } from "./ipc-health.js";
import { connectToQueueOwner } from "./ipc-transport.js";
import {
  resolveUsableQueueOwner,
  type QueueOwnerRecord,
  readQueueOwnerRecord,
} from "./lease-store.js";
import {
  parseQueueOwnerMessage,
  type QueueCancelRequest,
  type QueueCloseSessionRequest,
  type QueueOwnerCancelResultMessage,
  type QueueOwnerCloseSessionResultMessage,
  type QueueOwnerMessage,
  type QueueOwnerSetConfigOptionResultMessage,
  type QueueOwnerSetModelResultMessage,
  type QueueOwnerSetModeResultMessage,
  type QueueRequest,
  type QueueSetConfigOptionRequest,
  type QueueSetModelRequest,
  type QueueSetModeRequest,
  type QueueSubmitRequest,
} from "./messages.js";
import { assertQueueRequestSize } from "./request-limit.js";

export { QUEUE_CONNECT_RETRY_MS } from "./ipc-transport.js";
export const MAX_MESSAGE_BUFFER_SIZE = 10 * 1024 * 1024;
export {
  isProcessAlive,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  waitMs,
} from "./lease-store.js";
export type { QueueOwnerLease } from "./lease-store.js";

export { probeQueueOwnerHealth };
export type { QueueOwnerHealth };
export type { QueueOwnerMessage, QueueSubmitRequest } from "./messages.js";
export type { QueueOwnerControlHandlers, QueueTask } from "./ipc-server.js";
export { SessionQueueOwner } from "./ipc-server.js";

function assertOwnerGeneration(
  owner: QueueOwnerRecord,
  message: QueueOwnerMessage,
): QueueOwnerMessage {
  if (
    owner.ownerGeneration !== undefined &&
    message.ownerGeneration !== undefined &&
    message.ownerGeneration !== owner.ownerGeneration
  ) {
    throw new QueueProtocolError("Queue owner returned mismatched generation", {
      detailCode: "QUEUE_OWNER_GENERATION_MISMATCH",
      origin: "queue",
      retryable: true,
    });
  }
  return message;
}

type QueueOwnerRequestState = {
  acknowledged: boolean;
};

type QueueOwnerRequestControls<TResult> = {
  state: QueueOwnerRequestState;
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
};

function queueConnectionErrorFromOwner(
  message: Extract<QueueOwnerMessage, { type: "error" }>,
  outputAlreadyEmitted: boolean,
): QueueConnectionError {
  return new QueueConnectionError(message.message, {
    outputCode: message.code,
    detailCode: message.detailCode,
    origin: message.origin ?? "queue",
    retryable: message.retryable,
    acp: message.acp,
    ...(outputAlreadyEmitted ? { outputAlreadyEmitted: true } : {}),
  });
}

function makeMalformedQueueMessageError(): QueueProtocolError {
  return new QueueProtocolError("Queue owner sent malformed message", {
    detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
    origin: "queue",
    retryable: true,
  });
}

function notifyObserver(notify: (() => void) | undefined): void {
  try {
    notify?.();
  } catch {
    // A disconnected or throwing observer does not change the admitted operation.
  }
}

function uncertainQueueOutcome(error: unknown): QueueConnectionError | QueueProtocolError {
  const message = error instanceof Error ? error.message : "Queue request failed";
  const options = {
    detailCode:
      error instanceof QueueProtocolError ? error.detailCode : "QUEUE_SUBMISSION_OUTCOME_UNKNOWN",
    origin: "queue" as const,
    retryable: false,
  };
  const ErrorType = error instanceof QueueProtocolError ? QueueProtocolError : QueueConnectionError;
  return new ErrorType(
    `${message}; request outcome is unknown. Do not automatically resubmit.`,
    options,
  );
}

function emitQueueOwnerError(
  formatter: OutputFormatter,
  policy: OutputErrorEmissionPolicy | undefined,
  sessionId: string,
  message: Extract<QueueOwnerMessage, { type: "error" }>,
): QueueConnectionError {
  notifyObserver(() => formatter.setContext({ sessionId }));
  const queueErrorAlreadyEmitted = policy?.queueErrorAlreadyEmitted ?? true;
  const shouldEmitInFormatter = message.outputAlreadyEmitted !== true || !queueErrorAlreadyEmitted;
  if (shouldEmitInFormatter) {
    notifyObserver(() =>
      formatter.onError({
        code: message.code ?? "RUNTIME",
        detailCode: message.detailCode,
        origin: message.origin ?? "queue",
        message: message.message,
        retryable: message.retryable,
        acp: message.acp,
      }),
    );
    notifyObserver(() => formatter.flush());
  }
  // Mark formatter output as emitted even in quiet mode, so the CLI error
  // handler does not print the same failure again.
  return queueConnectionErrorFromOwner(message, queueErrorAlreadyEmitted || shouldEmitInFormatter);
}

function parseQueueOwnerResponseLine(
  owner: QueueOwnerRecord,
  requestId: string,
  line: string,
): QueueOwnerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new QueueProtocolError("Queue owner sent invalid JSON payload", {
      detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
      origin: "queue",
      retryable: true,
    });
  }

  const parsedMessage = parseQueueOwnerMessage(parsed);
  if (!parsedMessage) {
    throw makeMalformedQueueMessageError();
  }

  const message = assertOwnerGeneration(owner, parsedMessage);
  if (message.requestId !== requestId) {
    throw makeMalformedQueueMessageError();
  }

  return message;
}

async function runQueueOwnerRequest<TResult>(options: {
  owner: QueueOwnerRecord;
  request: QueueRequest;
  signal?: AbortSignal;
  /**
   * Last chance to refuse the request, invoked immediately before the socket
   * write. A throw means nothing was sent. It is never consulted afterwards, so
   * a dispatched request still settles its response.
   */
  assertDispatch?: () => void;
  onAccepted?: (controls: QueueOwnerRequestControls<TResult>) => void;
  onMessage: (message: QueueOwnerMessage, controls: QueueOwnerRequestControls<TResult>) => void;
  onClose: (controls: QueueOwnerRequestControls<TResult>) => void;
}): Promise<TResult | undefined> {
  options.signal?.throwIfAborted();
  const requestLine = JSON.stringify(options.request);
  assertQueueRequestSize(requestLine);
  const socket = await connectToQueueOwner(options.owner);
  if (!socket) {
    options.signal?.throwIfAborted();
    return undefined;
  }

  socket.setEncoding("utf8");

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const state: QueueOwnerRequestState = {
      acknowledged: false,
    };

    const finishResolve = (result: TResult) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.end();
      }
      resolve(result);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    };

    const onAbort = () => finishReject(options.signal?.reason);

    const controls: QueueOwnerRequestControls<TResult> = {
      state,
      resolve: finishResolve,
      reject: finishReject,
    };

    const processLine = (line: string): void => {
      let message: QueueOwnerMessage;
      try {
        message = parseQueueOwnerResponseLine(options.owner, options.request.requestId, line);
      } catch (error) {
        finishReject(uncertainQueueOutcome(error));
        return;
      }

      if (message.type === "accepted") {
        state.acknowledged = true;
        notifyObserver(() => options.onAccepted?.(controls));
        return;
      }

      try {
        options.onMessage(message, controls);
      } catch (error) {
        finishReject(uncertainQueueOutcome(error));
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (buffer.length > MAX_MESSAGE_BUFFER_SIZE) {
        socket.destroy();
        finishReject(
          uncertainQueueOutcome(
            new Error(`Message buffer exceeded ${MAX_MESSAGE_BUFFER_SIZE} bytes`),
          ),
        );
        return;
      }

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        if (settled) {
          return;
        }
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.once("error", (error: Error) => {
      finishReject(uncertainQueueOutcome(error));
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }
      options.onClose(controls);
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      options.assertDispatch?.();
    } catch (error) {
      finishReject(error);
      return;
    }
    try {
      socket.write(`${requestLine}\n`);
    } catch (error) {
      finishReject(uncertainQueueOutcome(error));
    }
  });
}

export type SubmitToQueueOwnerOptions = {
  sessionId: string;
  requestId?: string;
  requireSharedRuntime?: boolean;
  signal?: AbortSignal;
  message: string;
  prompt?: PromptInput;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  promptRetries?: number;
  waitForCompletion: boolean;
  verbose?: boolean;
  sessionOptions?: NonNullable<AcpClientOptions["sessionOptions"]>;
  /** Fires when the queue owner acknowledges the request (IPC accept), before completion. */
  onQueueAccepted?: () => void;
  /** Fires only when the owner writes the underlying ACP prompt request. */
  onPromptStarted?: () => void;
};

function missingQueueAckError(): QueueConnectionError {
  return new QueueConnectionError("Queue owner did not acknowledge request; outcome unknown", {
    detailCode: "QUEUE_ACK_MISSING",
    origin: "queue",
    retryable: false,
  });
}

function unexpectedQueueResponseError(): QueueProtocolError {
  return new QueueProtocolError("Queue owner returned unexpected response; outcome unknown", {
    detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
    origin: "queue",
    retryable: false,
  });
}

function handleAcknowledgedSubmitMessage(
  message: QueueOwnerMessage,
  controls: QueueOwnerRequestControls<SessionSendOutcome>,
  formatter: OutputFormatter,
): void {
  if (message.type === "event") {
    notifyObserver(() => formatter.onAcpMessage(message.message));
    return;
  }
  if (message.type === "permission_escalation") {
    notifyObserver(() => formatter.onPermissionEscalation(message.event));
    return;
  }
  if (message.type === "result") {
    notifyObserver(() => formatter.flush());
    controls.resolve(message.result);
    return;
  }
  controls.reject(unexpectedQueueResponseError());
}

function handleSubmitQueueOwnerMessage(
  message: QueueOwnerMessage,
  controls: QueueOwnerRequestControls<SessionSendOutcome>,
  options: SubmitToQueueOwnerOptions,
): void {
  if (message.type === "error") {
    controls.reject(
      emitQueueOwnerError(
        options.outputFormatter,
        options.errorEmissionPolicy,
        options.sessionId,
        message,
      ),
    );
    return;
  }
  if (!controls.state.acknowledged) {
    controls.reject(missingQueueAckError());
    return;
  }
  if (message.type === "prompt_started") {
    notifyObserver(options.onPromptStarted);
    return;
  }
  handleAcknowledgedSubmitMessage(message, controls, options.outputFormatter);
}

async function submitToQueueOwner(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const requestId = options.requestId ?? randomUUID();
  const request: QueueSubmitRequest = {
    type: "submit_prompt",
    requestId,
    ownerGeneration: owner.ownerGeneration,
    message: options.message,
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    promptRetries: options.promptRetries ?? 0,
    waitForCompletion: options.waitForCompletion,
    ...(options.onPromptStarted ? { reportPromptStarted: true } : {}),
    sessionOptions: options.sessionOptions,
  };

  notifyObserver(() =>
    options.outputFormatter.setContext({
      sessionId: options.sessionId,
    }),
  );

  return await runQueueOwnerRequest<SessionSendOutcome>({
    owner,
    request,
    signal: options.signal,
    onAccepted: ({ resolve }) => {
      notifyObserver(options.onQueueAccepted);
      notifyObserver(() =>
        options.outputFormatter.setContext({
          sessionId: options.sessionId,
        }),
      );
      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        resolve(queued);
      }
    },
    onMessage: (message, controls) => {
      handleSubmitQueueOwnerMessage(message, controls, options);
    },
    onClose: ({ state, resolve, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError(
            "Queue owner disconnected before acknowledging request; outcome unknown",
            {
              detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
              origin: "queue",
              retryable: false,
            },
          ),
        );
        return;
      }

      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        resolve(queued);
        return;
      }

      reject(
        new QueueConnectionError(
          "Queue owner disconnected before prompt completion; outcome unknown",
          {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
            origin: "queue",
            retryable: false,
          },
        ),
      );
    },
  });
}

async function submitControlToQueueOwner<TResponse extends QueueOwnerMessage>(
  owner: QueueOwnerRecord,
  request: QueueRequest,
  isExpectedResponse: (message: QueueOwnerMessage) => message is TResponse,
  assertDispatch?: () => void,
): Promise<TResponse | undefined> {
  return await runQueueOwnerRequest<TResponse>({
    owner,
    request,
    assertDispatch,
    onMessage: (message, { state, resolve, reject }) => {
      if (message.type === "error") {
        reject(queueConnectionErrorFromOwner(message, false));
        return;
      }

      if (!state.acknowledged) {
        reject(missingQueueAckError());
        return;
      }

      if (!isExpectedResponse(message)) {
        reject(unexpectedQueueResponseError());
        return;
      }

      resolve(message);
    },
    onClose: ({ state, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError(
            "Queue owner disconnected before acknowledging request; outcome unknown",
            {
              detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
              origin: "queue",
              retryable: false,
            },
          ),
        );
        return;
      }

      reject(
        new QueueConnectionError("Queue owner disconnected before responding; outcome unknown", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: false,
        }),
      );
    },
  });
}

async function submitCancelToQueueOwner(
  owner: QueueOwnerRecord,
  targetRequestId?: string,
): Promise<boolean | undefined> {
  if (targetRequestId !== undefined) {
    assertSharedRuntimeOwner(owner);
  }
  const request: QueueCancelRequest = {
    type: "cancel_prompt",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    ...(targetRequestId !== undefined ? { targetRequestId } : {}),
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCancelResultMessage => message.type === "cancel_result",
  );
  return response?.cancelled;
}

async function submitSetModeToQueueOwner(
  owner: QueueOwnerRecord,
  modeId: string,
  timeoutMs?: number,
  assertDispatch?: () => void,
): Promise<boolean | undefined> {
  const request: QueueSetModeRequest = {
    type: "set_mode",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    modeId,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModeResultMessage => message.type === "set_mode_result",
    assertDispatch,
  );
  return response ? true : undefined;
}

async function submitSetModelToQueueOwner(
  owner: QueueOwnerRecord,
  modelId: string,
  timeoutMs?: number,
  assertDispatch?: () => void,
): Promise<QueueOwnerSetModelResultMessage | undefined> {
  const request: QueueSetModelRequest = {
    type: "set_model",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    modelId,
    timeoutMs,
  };
  return await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModelResultMessage => message.type === "set_model_result",
    assertDispatch,
  );
}

async function submitSetConfigOptionToQueueOwner(
  owner: QueueOwnerRecord,
  configId: string,
  value: string,
  timeoutMs?: number,
  assertDispatch?: () => void,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const request: QueueSetConfigOptionRequest = {
    type: "set_config_option",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    configId,
    value,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetConfigOptionResultMessage =>
      message.type === "set_config_option_result",
    assertDispatch,
  );
  return response?.response;
}

async function submitCloseSessionToQueueOwner(
  owner: QueueOwnerRecord,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueCloseSessionRequest = {
    type: "close_session",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCloseSessionResultMessage =>
      message.type === "close_session_result",
  );
  return response?.closed;
}

function queueOwnerMcpConfigMatches(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): boolean {
  return (
    owner.mcpConfigPath === options.mcpConfigPath &&
    owner.mcpConfigFingerprint === options.mcpConfigFingerprint
  );
}

function assertQueueOwnerMcpConfigMatches(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): void {
  if (queueOwnerMcpConfigMatches(owner, options)) {
    return;
  }
  throw new QueueConnectionError(
    "Session queue owner uses a different MCP config; close the session before retrying",
    {
      detailCode: "QUEUE_MCP_CONFIG_CONFLICT",
      origin: "queue",
      retryable: false,
    },
  );
}

function assertSharedRuntimeOwner(owner: QueueOwnerRecord): void {
  if (owner.sharedRuntime === true) {
    return;
  }
  throw new QueueConnectionError(
    "The running queue owner predates shared runtime support. Wait for its idle expiry or close the session before retrying.",
    { detailCode: "QUEUE_SHARED_RUNTIME_UNSUPPORTED", origin: "queue", retryable: false },
  );
}

export async function trySubmitToRunningOwner(
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  options.signal?.throwIfAborted();
  const observed = await readQueueOwnerRecord(options.sessionId);
  if (!observed) {
    return undefined;
  }
  const owner = await resolveUsableQueueOwner(options.sessionId, observed);
  if (!owner) {
    return undefined;
  }
  if (options.requireSharedRuntime) {
    assertSharedRuntimeOwner(owner);
  }
  assertQueueOwnerMcpConfigMatches(owner, options);

  const submitted = await submitToQueueOwner(owner, options);
  if (submitted) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queued prompt on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return submitted;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting queue requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

async function tryControlOnRunningOwner<T>(options: {
  sessionId: string;
  verbose?: boolean;
  requestName: string;
  logPrefix: string;
  submit: (owner: QueueOwnerRecord) => Promise<T | undefined>;
}): Promise<T | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }
  const response = await options.submit(owner);
  if (response !== undefined) {
    if (options.verbose) {
      process.stderr.write(`${options.logPrefix} ${owner.pid} for session ${options.sessionId}\n`);
    }
    return response;
  }
  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }
  throw new QueueConnectionError(
    `Session queue owner is running but not accepting ${options.requestName} requests`,
    { detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS", origin: "queue", retryable: true },
  );
}

export async function tryCloseSessionOnRunningOwner(options: {
  sessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  return await tryControlOnRunningOwner({
    sessionId: options.sessionId,
    verbose: options.verbose,
    requestName: "close_session",
    logPrefix: "[acpx] requested session/close on active owner pid",
    submit: (owner) => submitCloseSessionToQueueOwner(owner, options.timeoutMs),
  });
}

export async function tryCancelOnRunningOwner(options: {
  sessionId: string;
  verbose?: boolean;
  targetRequestId?: string;
}): Promise<boolean | undefined> {
  return await tryControlOnRunningOwner({
    sessionId: options.sessionId,
    verbose: options.verbose,
    requestName: "cancel",
    logPrefix: "[acpx] requested cancel on active owner pid",
    submit: (owner) => submitCancelToQueueOwner(owner, options.targetRequestId),
  });
}

type OwnerControlResult<T> = {
  value: T;
  persistsControlState: boolean;
};

async function withOwnerControlPersistence<T>(
  owner: QueueOwnerRecord,
  operation: Promise<T | undefined>,
): Promise<OwnerControlResult<T> | undefined> {
  const persistsControlState = owner.persistsControlState === true;
  const value = await operation;
  return value === undefined ? undefined : { value, persistsControlState };
}

export async function trySetModeOnRunningOwner(
  sessionId: string,
  modeId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
  assertDispatch?: () => void,
): Promise<OwnerControlResult<boolean> | undefined> {
  return await tryControlOnRunningOwner({
    sessionId,
    verbose,
    requestName: "set_mode",
    logPrefix: "[acpx] requested session/set_mode on owner pid",
    submit: (owner) =>
      withOwnerControlPersistence(
        owner,
        submitSetModeToQueueOwner(owner, modeId, timeoutMs, assertDispatch),
      ),
  });
}

export async function trySetModelOnRunningOwner(
  sessionId: string,
  modelId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
  assertDispatch?: () => void,
): Promise<OwnerControlResult<QueueOwnerSetModelResultMessage> | undefined> {
  return await tryControlOnRunningOwner({
    sessionId,
    verbose,
    requestName: "set_model",
    logPrefix: "[acpx] requested a model config update on owner pid",
    submit: (owner) =>
      withOwnerControlPersistence(
        owner,
        submitSetModelToQueueOwner(owner, modelId, timeoutMs, assertDispatch),
      ),
  });
}

export async function trySetConfigOptionOnRunningOwner(
  sessionId: string,
  configId: string,
  value: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
  assertDispatch?: () => void,
): Promise<OwnerControlResult<SetSessionConfigOptionResponse> | undefined> {
  return await tryControlOnRunningOwner({
    sessionId,
    verbose,
    requestName: "set_config_option",
    logPrefix: "[acpx] requested session/set_config_option on owner pid",
    submit: (owner) =>
      withOwnerControlPersistence(
        owner,
        submitSetConfigOptionToQueueOwner(owner, configId, value, timeoutMs, assertDispatch),
      ),
  });
}
