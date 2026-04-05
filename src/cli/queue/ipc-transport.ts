import net from "node:net";
import { measurePerf } from "../../perf-metrics.js";
import { type QueueOwnerRecord, waitMs } from "./lease-store.js";

const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;
export const SOCKET_CONNECTION_TIMEOUT_MS = 5000;

function shouldRetryQueueConnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function connectToSocket(
  socketPath: string,
  timeoutMs = SOCKET_CONNECTION_TIMEOUT_MS,
): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error(`Connection to ${socketPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onConnect = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export async function connectToQueueOwner(
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
