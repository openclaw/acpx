import { randomUUID } from "node:crypto";
import net from "node:net";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError, QueueProtocolError } from "./errors.js";
import { incrementPerfCounter, measurePerf } from "./perf-metrics.js";
import {
  type QueueOwnerLease,
  type QueueOwnerRecord,
  isProcessAlive,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  waitMs,
} from "./queue-lease-store.js";
import {
  parseQueueOwnerMessage,
  type QueueCancelRequest,
  type QueueOwnerCancelResultMessage,
  type QueueOwnerMessage,
  type QueueOwnerSetConfigOptionResultMessage,
  type QueueOwnerSetModeResultMessage,
  type QueueRequest,
  type QueueSetConfigOptionRequest,
  type QueueSetModeRequest,
  type QueueSubmitRequest,
} from "./queue-messages.js";
import type {
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  PromptInput,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "./types.js";

const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;
export {
  isProcessAlive,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  waitMs,
} from "./queue-lease-store.js";
export type { QueueOwnerLease } from "./queue-lease-store.js";

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
export type QueueOwnerHealth = {
  sessionId: string;
  hasLease: boolean;
  healthy: boolean;
  socketReachable: boolean;
  pidAlive: boolean;
  pid?: number;
  socketPath?: string;
  ownerGeneration?: number;
  queueDepth?: number;
};

export type { QueueOwnerMessage, QueueSubmitRequest } from "./queue-messages.js";
export type { QueueOwnerControlHandlers, QueueTask } from "./queue-ipc-server.js";
export { SessionQueueOwner } from "./queue-ipc-server.js";

function shouldRetryQueueConnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function connectToSocket(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function connectToQueueOwner(
  owner: QueueOwnerRecord,
  maxAttempts = QUEUE_CONNECT_ATTEMPTS,
): Promise<net.Socket | undefined> {
  let lastError: unknown;

  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await measurePerf(
        "queue.connect",
        async () => await connectToSocket(owner.socketPath),
      );
    } catch (error) {
      lastError = error;
      if (!shouldRetryQueueConnect(error)) {
        throw error;
      }
      await waitMs(QUEUE_CONNECT_RETRY_MS);
    }
  }

  if (lastError && !shouldRetryQueueConnect(lastError)) {
    throw lastError;
  }

  return undefined;
}

export async function probeQueueOwnerHealth(sessionId: string): Promise<QueueOwnerHealth> {
  const ownerRecord = await readQueueOwnerRecord(sessionId);
  if (!ownerRecord) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  const owner = await readQueueOwnerStatus(sessionId);
  if (!owner) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  const pidAlive = owner.alive;
  let socketReachable = false;
  try {
    const socket = await connectToQueueOwner(ownerRecord, 2);
    if (socket) {
      socketReachable = true;
      if (!socket.destroyed) {
        socket.end();
      }
    }
  } catch {
    socketReachable = false;
  }

  return {
    sessionId,
    hasLease: true,
    healthy: socketReachable,
    socketReachable,
    pidAlive,
    pid: owner.pid,
    socketPath: owner.socketPath,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
  };
}

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

export type SubmitToQueueOwnerOptions = {
  sessionId: string;
  message: string;
  prompt?: PromptInput;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  waitForCompletion: boolean;
  verbose?: boolean;
};

async function submitToQueueOwner(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const socket = await connectToQueueOwner(owner);
  if (!socket) {
    return undefined;
  }

  socket.setEncoding("utf8");
  const requestId = randomUUID();
  const request: QueueSubmitRequest = {
    type: "submit_prompt",
    requestId,
    ownerGeneration: owner.ownerGeneration,
    message: options.message,
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    waitForCompletion: options.waitForCompletion,
  };

  options.outputFormatter.setContext({
    sessionId: options.sessionId,
  });

  return await new Promise<SessionSendOutcome>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = "";

    const finishResolve = (result: SessionSendOutcome) => {
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

    const processLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finishReject(
          new QueueProtocolError("Queue owner sent invalid JSON payload", {
            detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      const parsedMessage = parseQueueOwnerMessage(parsed);
      if (!parsedMessage) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }
      const message = assertOwnerGeneration(owner, parsedMessage);
      if (message.requestId !== requestId) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        options.outputFormatter.setContext({
          sessionId: options.sessionId,
        });
        if (!options.waitForCompletion) {
          const queued: SessionEnqueueResult = {
            queued: true,
            sessionId: options.sessionId,
            requestId,
          };
          finishResolve(queued);
        }
        return;
      }

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
        finishReject(
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

      if (!acknowledged) {
        finishReject(
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
        finishResolve(message.result);
        return;
      }

      finishReject(
        new QueueProtocolError("Queue owner returned unexpected response", {
          detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
          origin: "queue",
          retryable: true,
        }),
      );
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

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

      if (!acknowledged) {
        finishReject(
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
        finishResolve(queued);
        return;
      }

      finishReject(
        new QueueConnectionError("Queue owner disconnected before prompt completion", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    });

    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function submitControlToQueueOwner<TResponse extends QueueOwnerMessage>(
  owner: QueueOwnerRecord,
  request: QueueRequest,
  isExpectedResponse: (message: QueueOwnerMessage) => message is TResponse,
): Promise<TResponse | undefined> {
  const socket = await connectToQueueOwner(owner);
  if (!socket) {
    return undefined;
  }

  socket.setEncoding("utf8");

  return await new Promise<TResponse>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = "";

    const finishResolve = (result: TResponse) => {
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

    const processLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finishReject(
          new QueueProtocolError("Queue owner sent invalid JSON payload", {
            detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      const parsedMessage = parseQueueOwnerMessage(parsed);
      if (!parsedMessage) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }
      const message = assertOwnerGeneration(owner, parsedMessage);
      if (message.requestId !== request.requestId) {
        finishReject(
          new QueueProtocolError("Queue owner sent malformed message", {
            detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (message.type === "accepted") {
        acknowledged = true;
        return;
      }

      if (message.type === "error") {
        finishReject(
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

      if (!acknowledged) {
        finishReject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (!isExpectedResponse(message)) {
        finishReject(
          new QueueProtocolError("Queue owner returned unexpected response", {
            detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      finishResolve(message);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

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
      if (!acknowledged) {
        finishReject(
          new QueueConnectionError("Queue owner disconnected before acknowledging request", {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }
      finishReject(
        new QueueConnectionError("Queue owner disconnected before responding", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    });

    socket.write(`${JSON.stringify(request)}\n`);
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
