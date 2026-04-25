import { randomUUID } from "node:crypto";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError, QueueProtocolError } from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  PromptInput,
  SessionResumePolicy,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "../../types.js";
import { probeQueueOwnerHealth, type QueueOwnerHealth } from "./ipc-health.js";
import { QUEUE_CONNECT_RETRY_MS, connectToQueueOwner } from "./ipc-transport.js";
import {
  type QueueOwnerRecord,
  readQueueOwnerRecord,
  terminateQueueOwnerForSession,
} from "./lease-store.js";
import {
  parseQueueOwnerMessage,
  type QueueCancelRequest,
  type QueueOwnerCancelResultMessage,
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

const STALE_OWNER_PROTOCOL_DETAIL_CODES = new Set([
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
]);

async function maybeRecoverStaleOwnerAfterProtocolMismatch(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  error: unknown;
  verbose?: boolean;
}): Promise<boolean> {
  if (!(params.error instanceof QueueProtocolError)) {
    return false;
  }

  const detailCode = params.error.detailCode;
  if (!detailCode || !STALE_OWNER_PROTOCOL_DETAIL_CODES.has(detailCode)) {
    return false;
  }

  await terminateQueueOwnerForSession(params.sessionId).catch(() => {
    // Preserve existing behavior if cleanup fails.
  });
  incrementPerfCounter("queue.owner.stale_recovered");

  if (params.verbose) {
    process.stderr.write(
      `[acpx] dropped stale queue owner metadata after protocol mismatch for session ${params.sessionId} (${detailCode})\n`,
    );
  }

  return true;
}
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

function makeMalformedQueueMessageError(): QueueProtocolError {
  return new QueueProtocolError("Queue owner sent malformed message", {
    detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
    origin: "queue",
    retryable: true,
  });
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
  onAccepted?: (controls: QueueOwnerRequestControls<TResult>) => void;
  onMessage: (message: QueueOwnerMessage, controls: QueueOwnerRequestControls<TResult>) => void;
  onClose: (controls: QueueOwnerRequestControls<TResult>) => void;
}): Promise<TResult | undefined> {
  const socket = await connectToQueueOwner(options.owner);
  if (!socket) {
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
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    };

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
        finishReject(error);
        return;
      }

      if (message.type === "accepted") {
        state.acknowledged = true;
        options.onAccepted?.(controls);
        return;
      }

      options.onMessage(message, controls);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (buffer.length > MAX_MESSAGE_BUFFER_SIZE) {
        socket.destroy();
        finishReject(new Error(`Message buffer exceeded ${MAX_MESSAGE_BUFFER_SIZE} bytes`));
        return;
      }

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.once("error", (error: Error) => {
      finishReject(error);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }
      options.onClose(controls);
    });

    socket.write(`${JSON.stringify(options.request)}\n`);
  });
}

export type SubmitToQueueOwnerOptions = {
  sessionId: string;
  message: string;
  prompt?: PromptInput;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  waitForCompletion: boolean;
  verbose?: boolean;
  sessionOptions?: NonNullable<AcpClientOptions["sessionOptions"]>;
};

async function submitToQueueOwner(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const requestId = randomUUID();
  const request: QueueSubmitRequest = {
    type: "submit_prompt",
    requestId,
    ownerGeneration: owner.ownerGeneration,
    message: options.message,
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    waitForCompletion: options.waitForCompletion,
    sessionOptions: options.sessionOptions,
  };

  options.outputFormatter.setContext({
    sessionId: options.sessionId,
  });

  return await runQueueOwnerRequest<SessionSendOutcome>({
    owner,
    request,
    onAccepted: ({ resolve }) => {
      options.outputFormatter.setContext({
        sessionId: options.sessionId,
      });
      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        resolve(queued);
      }
    },
    onMessage: (message, { state, resolve, reject }) => {
      if (message.type === "error") {
        options.outputFormatter.setContext({
          sessionId: options.sessionId,
        });

        const queueErrorAlreadyEmitted =
          options.errorEmissionPolicy?.queueErrorAlreadyEmitted ?? true;
        const outputAlreadyEmitted = message.outputAlreadyEmitted === true;
        const shouldEmitInFormatter = !outputAlreadyEmitted || !queueErrorAlreadyEmitted;
        if (shouldEmitInFormatter) {
          options.outputFormatter.onError({
            code: message.code ?? "RUNTIME",
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            message: message.message,
            retryable: message.retryable,
            acp: message.acp,
          });
          options.outputFormatter.flush();
        }
        reject(
          new QueueConnectionError(message.message, {
            outputCode: message.code,
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            retryable: message.retryable,
            acp: message.acp,
            ...(queueErrorAlreadyEmitted ? { outputAlreadyEmitted: true } : {}),
          }),
        );
        return;
      }

      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "event") {
        options.outputFormatter.onAcpMessage(message.message);
        return;
      }

      if (message.type === "result") {
        options.outputFormatter.flush();
        resolve(message.result);
        return;
      }

      reject(
        new QueueProtocolError("Queue owner returned unexpected response", {
          detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
          origin: "queue",
          retryable: true,
        }),
      );
    },
    onClose: ({ state, resolve, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner disconnected before acknowledging request", {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
            origin: "queue",
            retryable: true,
          }),
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
        new QueueConnectionError("Queue owner disconnected before prompt completion", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    },
  });
}

async function submitControlToQueueOwner<TResponse extends QueueOwnerMessage>(
  owner: QueueOwnerRecord,
  request: QueueRequest,
  isExpectedResponse: (message: QueueOwnerMessage) => message is TResponse,
): Promise<TResponse | undefined> {
  return await runQueueOwnerRequest<TResponse>({
    owner,
    request,
    onMessage: (message, { state, resolve, reject }) => {
      if (message.type === "error") {
        reject(
          new QueueConnectionError(message.message, {
            outputCode: message.code,
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            retryable: message.retryable,
            acp: message.acp,
          }),
        );
        return;
      }

      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (!isExpectedResponse(message)) {
        reject(
          new QueueProtocolError("Queue owner returned unexpected response", {
            detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      resolve(message);
    },
    onClose: ({ state, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner disconnected before acknowledging request", {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      reject(
        new QueueConnectionError("Queue owner disconnected before responding", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    },
  });
}

async function submitCancelToQueueOwner(owner: QueueOwnerRecord): Promise<boolean | undefined> {
  const request: QueueCancelRequest = {
    type: "cancel_prompt",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCancelResultMessage => message.type === "cancel_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched cancel response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.cancelled;
}

async function submitSetModeToQueueOwner(
  owner: QueueOwnerRecord,
  modeId: string,
  timeoutMs?: number,
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
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_mode response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return true;
}

async function submitSetModelToQueueOwner(
  owner: QueueOwnerRecord,
  modelId: string,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueSetModelRequest = {
    type: "set_model",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    modelId,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModelResultMessage => message.type === "set_model_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_model response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return true;
}

async function submitSetConfigOptionToQueueOwner(
  owner: QueueOwnerRecord,
  configId: string,
  value: string,
  timeoutMs?: number,
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
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_config_option response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.response;
}

export async function trySubmitToRunningOwner(
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  let submitted: SessionSendOutcome | undefined;
  try {
    submitted = await submitToQueueOwner(owner, options);
  } catch (error) {
    const recovered = await maybeRecoverStaleOwnerAfterProtocolMismatch({
      sessionId: options.sessionId,
      owner,
      error,
      verbose: options.verbose,
    });
    if (recovered) {
      return undefined;
    }
    throw error;
  }
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

export async function tryCancelOnRunningOwner(options: {
  sessionId: string;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  const cancelled = await submitCancelToQueueOwner(owner);
  if (cancelled !== undefined) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] requested cancel on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return cancelled;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting cancel requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

export async function trySetModeOnRunningOwner(
  sessionId: string,
  modeId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const submitted = await submitSetModeToQueueOwner(owner, modeId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_mode on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_mode requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

export async function trySetModelOnRunningOwner(
  sessionId: string,
  modelId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const submitted = await submitSetModelToQueueOwner(owner, modelId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_model on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_model requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

export async function trySetConfigOptionOnRunningOwner(
  sessionId: string,
  configId: string,
  value: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const response = await submitSetConfigOptionToQueueOwner(owner, configId, value, timeoutMs);
  if (response) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_config_option on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return response;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_config_option requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}
