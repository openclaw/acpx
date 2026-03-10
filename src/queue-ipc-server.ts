import net from "node:net";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeOutputError } from "./error-normalization.js";
import { recordPerfDuration } from "./perf-metrics.js";
import { textPrompt } from "./prompt-content.js";
import {
  parseQueueRequest,
  type QueueOwnerErrorMessage,
  type QueueOwnerMessage,
} from "./queue-messages.js";
import type { NonInteractivePermissionPolicy, PermissionMode, PromptInput } from "./types.js";

type QueueOwnerSocketLease = {
  socketPath: string;
  ownerGeneration?: number;
};

function makeQueueOwnerError(
  requestId: string,
  message: string,
  detailCode: string,
  options: {
    retryable?: boolean;
  } = {},
): QueueOwnerErrorMessage {
  return {
    type: "error",
    requestId,
    ownerGeneration: undefined,
    code: "RUNTIME",
    detailCode,
    origin: "queue",
    retryable: options.retryable,
    message,
  };
}

function makeQueueOwnerErrorFromUnknown(
  requestId: string,
  error: unknown,
  detailCode: string,
  options: {
    retryable?: boolean;
  } = {},
): QueueOwnerErrorMessage {
  const normalized = normalizeOutputError(error, {
    defaultCode: "RUNTIME",
    origin: "queue",
    detailCode,
    retryable: options.retryable,
  });

  return {
    type: "error",
    requestId,
    code: normalized.code,
    detailCode: normalized.detailCode,
    origin: normalized.origin,
    message: normalized.message,
    retryable: normalized.retryable,
    acp: normalized.acp,
  };
}

function writeQueueMessage(socket: net.Socket, message: QueueOwnerMessage): void {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

export type QueueTask = {
  requestId: string;
  message: string;
  prompt: PromptInput;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  waitForCompletion: boolean;
  enqueuedAt: number;
  send: (message: QueueOwnerMessage) => void;
  close: () => void;
};

export type QueueOwnerControlHandlers = {
  cancelPrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type SessionQueueOwnerOptions = {
  maxQueueDepth: number;
  onQueueDepthChanged?: (queueDepth: number) => void;
};

export class SessionQueueOwner {
  private readonly server: net.Server;
  private readonly controlHandlers: QueueOwnerControlHandlers;
  private readonly ownerGeneration?: number;
  private readonly maxQueueDepth: number;
  private readonly onQueueDepthChanged?: (queueDepth: number) => void;
  private readonly pending: QueueTask[] = [];
  private readonly waiters: Array<(task: QueueTask | undefined) => void> = [];
  private closed = false;

  private constructor(
    server: net.Server,
    controlHandlers: QueueOwnerControlHandlers,
    lease: QueueOwnerSocketLease,
    options: SessionQueueOwnerOptions,
  ) {
    this.server = server;
    this.controlHandlers = controlHandlers;
    this.ownerGeneration = lease.ownerGeneration;
    this.maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth));
    this.onQueueDepthChanged = options.onQueueDepthChanged;
  }

  static async start(
    lease: QueueOwnerSocketLease,
    controlHandlers: QueueOwnerControlHandlers,
    options: SessionQueueOwnerOptions = {
      maxQueueDepth: 16,
    },
  ): Promise<SessionQueueOwner> {
    const ownerRef: { current: SessionQueueOwner | undefined } = { current: undefined };
    const server = net.createServer((socket) => {
      ownerRef.current?.handleConnection(socket);
    });
    ownerRef.current = new SessionQueueOwner(server, controlHandlers, lease, options);

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(lease.socketPath);
    });

    return ownerRef.current;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }

    for (const task of this.pending.splice(0)) {
      if (task.waitForCompletion) {
        task.send(
          makeQueueOwnerError(
            task.requestId,
            "Queue owner shutting down before prompt execution",
            "QUEUE_OWNER_SHUTTING_DOWN",
            {
              retryable: true,
            },
          ),
        );
      }
      task.close();
    }
    this.emitQueueDepth();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  async nextTask(timeoutMs?: number): Promise<QueueTask | undefined> {
    if (this.pending.length > 0) {
      const task = this.pending.shift();
      this.emitQueueDepth();
      if (task) {
        recordPerfDuration("queue.owner.wait_ms", Date.now() - task.enqueuedAt);
      }
      return task;
    }
    if (this.closed) {
      return undefined;
    }

    return await new Promise<QueueTask | undefined>((resolve) => {
      const shouldTimeout = timeoutMs != null;
      const timer =
        shouldTimeout &&
        setTimeout(
          () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) {
              this.waiters.splice(index, 1);
            }
            resolve(undefined);
          },
          Math.max(0, timeoutMs),
        );

      const waiter = (task: QueueTask | undefined) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(task);
      };

      this.waiters.push(waiter);
    });
  }

  queueDepth(): number {
    return this.pending.length;
  }

  private emitQueueDepth(): void {
    this.onQueueDepthChanged?.(this.pending.length);
  }

  private enqueue(task: QueueTask): void {
    if (this.closed) {
      if (task.waitForCompletion) {
        task.send(
          makeQueueOwnerError(
            task.requestId,
            "Queue owner is shutting down",
            "QUEUE_OWNER_SHUTTING_DOWN",
            {
              retryable: true,
            },
          ),
        );
      }
      task.close();
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(task);
      return;
    }

    if (this.pending.length >= this.maxQueueDepth) {
      if (task.waitForCompletion) {
        task.send({
          ...makeQueueOwnerError(
            task.requestId,
            `Queue owner is overloaded (${this.pending.length}/${this.maxQueueDepth} queued)`,
            "QUEUE_OWNER_OVERLOADED",
            {
              retryable: true,
            },
          ),
          ownerGeneration: this.ownerGeneration,
        });
      }
      task.close();
      return;
    }

    this.pending.push(task);
    this.emitQueueDepth();
  }

  private handleControlRequest<TMessage extends QueueOwnerMessage>(options: {
    socket: net.Socket;
    requestId: string;
    run: () => Promise<TMessage>;
  }): void {
    writeQueueMessage(options.socket, {
      type: "accepted",
      requestId: options.requestId,
      ownerGeneration: this.ownerGeneration,
    });

    void options
      .run()
      .then((message) => {
        writeQueueMessage(options.socket, {
          ...message,
          ownerGeneration: this.ownerGeneration,
        });
      })
      .catch((error) => {
        writeQueueMessage(options.socket, {
          ...makeQueueOwnerErrorFromUnknown(
            options.requestId,
            error,
            "QUEUE_CONTROL_REQUEST_FAILED",
          ),
          ownerGeneration: this.ownerGeneration,
        });
      })
      .finally(() => {
        if (!options.socket.destroyed) {
          options.socket.end();
        }
      });
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");

    if (this.closed) {
      writeQueueMessage(
        socket,
        makeQueueOwnerError("unknown", "Queue owner is closed", "QUEUE_OWNER_CLOSED", {
          retryable: true,
        }),
      );
      socket.end();
      return;
    }

    let buffer = "";
    let handled = false;

    const fail = (requestId: string, message: string, detailCode: string): void => {
      writeQueueMessage(socket, {
        ...makeQueueOwnerError(requestId, message, detailCode, {
          retryable: false,
        }),
        ownerGeneration: this.ownerGeneration,
      });
      socket.end();
    };

    const processLine = (line: string): void => {
      if (handled) {
        return;
      }
      handled = true;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("unknown", "Invalid queue request payload", "QUEUE_REQUEST_PAYLOAD_INVALID_JSON");
        return;
      }

      const request = parseQueueRequest(parsed);
      if (!request) {
        fail("unknown", "Invalid queue request", "QUEUE_REQUEST_INVALID");
        return;
      }

      if (
        request.ownerGeneration !== undefined &&
        this.ownerGeneration !== undefined &&
        request.ownerGeneration !== this.ownerGeneration
      ) {
        fail(
          request.requestId,
          "Queue request targeted a stale queue owner generation",
          "QUEUE_OWNER_GENERATION_MISMATCH",
        );
        return;
      }

      if (request.type === "cancel_prompt") {
        this.handleControlRequest({
          socket,
          requestId: request.requestId,
          run: async () => ({
            type: "cancel_result",
            requestId: request.requestId,
            cancelled: await this.controlHandlers.cancelPrompt(),
          }),
        });
        return;
      }

      if (request.type === "set_mode") {
        this.handleControlRequest({
          socket,
          requestId: request.requestId,
          run: async () => {
            await this.controlHandlers.setSessionMode(request.modeId, request.timeoutMs);
            return {
              type: "set_mode_result",
              requestId: request.requestId,
              modeId: request.modeId,
            };
          },
        });
        return;
      }

      if (request.type === "set_config_option") {
        this.handleControlRequest({
          socket,
          requestId: request.requestId,
          run: async () => ({
            type: "set_config_option_result",
            requestId: request.requestId,
            response: await this.controlHandlers.setSessionConfigOption(
              request.configId,
              request.value,
              request.timeoutMs,
            ),
          }),
        });
        return;
      }

      const task: QueueTask = {
        requestId: request.requestId,
        message: request.message,
        prompt: request.prompt ?? textPrompt(request.message),
        permissionMode: request.permissionMode,
        nonInteractivePermissions: request.nonInteractivePermissions,
        timeoutMs: request.timeoutMs,
        suppressSdkConsoleErrors: request.suppressSdkConsoleErrors,
        waitForCompletion: request.waitForCompletion,
        enqueuedAt: Date.now(),
        send: (message) => {
          writeQueueMessage(socket, {
            ...message,
            ownerGeneration: this.ownerGeneration,
          });
        },
        close: () => {
          if (!socket.destroyed) {
            socket.end();
          }
        },
      };

      writeQueueMessage(socket, {
        type: "accepted",
        requestId: request.requestId,
        ownerGeneration: this.ownerGeneration,
      });

      if (!request.waitForCompletion) {
        task.close();
      }

      this.enqueue(task);
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

    socket.on("error", () => {
      // no-op: queue processing continues even if client disconnects
    });
  }
}
