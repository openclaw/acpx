import type http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { createReplayPatch } from "../src/lib/json-patch-plus.js";
import type {
  ReplayJsonPatchOperation,
  ReplayProtocol,
  ReplayServerMessage,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../src/types.js";
import type { ViewerRunSource } from "./live-source.js";

const PROTOCOL: ReplayProtocol = "acpx.replay.v1";
const DEFAULT_POLL_INTERVAL_MS = 50;
const replayClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.string() }),
  z.object({ type: z.enum(["subscribe_runs", "unsubscribe_runs", "resync_runs", "ping"]) }),
  z.object({
    type: z.enum(["subscribe_run", "unsubscribe_run", "resync_run"]),
    runId: z.string(),
  }),
]);

type ReplayLiveSyncOptions = {
  source: ViewerRunSource;
  pollIntervalMs?: number;
};

type ResourceState<TState> = {
  version: number;
  state: TState | null;
  pending?: Promise<void>;
  snapshotRequests: Set<ClientSubscriptionState>;
};

type ResourceDelta<TState> =
  | { kind: "noop" }
  | { kind: "patch"; ops: ReplayJsonPatchOperation[] }
  | { kind: "snapshot"; state: TState };

type SubscriptionState = "pending" | "active";

type ClientSubscriptionState = {
  socket: WebSocket;
  runsSubscription?: SubscriptionState;
  runSubscriptions: Map<string, SubscriptionState>;
};

export type ReplayLiveSyncServer = {
  handleUpgrade(request: http.IncomingMessage, socket: net.Socket | Duplex, head: Buffer): boolean;
  close(): Promise<void>;
};

export function computeResourceDelta<TState extends object>(
  previousState: TState,
  nextState: TState,
  createPatch: typeof createReplayPatch<TState> = createReplayPatch,
): ResourceDelta<TState> {
  try {
    const ops = createPatch(previousState, nextState);
    if (ops.length === 0) {
      return { kind: "noop" };
    }
    return { kind: "patch", ops };
  } catch {
    return { kind: "snapshot", state: nextState };
  }
}

export function createReplayLiveSyncServer(options: ReplayLiveSyncOptions): ReplayLiveSyncServer {
  const source = options.source;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const server = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientSubscriptionState>();
  const runsResource: ResourceState<ViewerRunsState> = {
    version: 0,
    state: null,
    snapshotRequests: new Set(),
  };
  const runResources = new Map<string, ResourceState<ViewerRunLiveState>>();
  let pollTimer: NodeJS.Timeout | null = null;
  let syncing = false;

  server.on("connection", (socket) => {
    const client: ClientSubscriptionState = {
      socket,
      runSubscriptions: new Map(),
    };
    clients.add(client);
    sendMessage(socket, {
      type: "ready",
      protocol: PROTOCOL,
    });

    socket.on("message", (data) => {
      void handleMessage(client, data).catch((error: unknown) => {
        sendInternalError(socket, error);
      });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clients.delete(client);
      runsResource.snapshotRequests.delete(client);
      for (const resource of runResources.values()) {
        resource.snapshotRequests.delete(client);
      }
      pruneRunResources();
      refreshPollingState();
    });
  });

  async function handleMessage(client: ClientSubscriptionState, data: RawData): Promise<void> {
    let message: z.infer<typeof replayClientMessageSchema>;
    try {
      if (!Buffer.isBuffer(data)) {
        throw new Error("Expected buffered WebSocket data");
      }
      message = replayClientMessageSchema.parse(JSON.parse(data.toString()));
    } catch {
      sendMessage(client.socket, {
        type: "error",
        code: "protocol_error",
        message: "Invalid replay viewer message payload.",
      });
      return;
    }

    switch (message.type) {
      case "hello":
        if (message.protocol !== PROTOCOL) {
          sendMessage(client.socket, {
            type: "error",
            code: "protocol_error",
            message: "Unsupported replay protocol.",
          });
        }
        return;
      case "ping":
        sendMessage(client.socket, { type: "pong" });
        return;
      case "subscribe_runs":
      case "resync_runs":
        client.runsSubscription ??= "pending";
        await sendRunsSnapshot(client);
        refreshPollingState();
        return;
      case "unsubscribe_runs":
        client.runsSubscription = undefined;
        runsResource.snapshotRequests.delete(client);
        refreshPollingState();
        return;
      case "subscribe_run":
      case "resync_run":
        client.runSubscriptions.set(
          message.runId,
          client.runSubscriptions.get(message.runId) ?? "pending",
        );
        await sendRunSnapshot(client, message.runId);
        refreshPollingState();
        return;
      case "unsubscribe_run":
        client.runSubscriptions.delete(message.runId);
        runResources.get(message.runId)?.snapshotRequests.delete(client);
        pruneRunResources();
        refreshPollingState();
        return;
    }
  }

  async function sendRunsSnapshot(client: ClientSubscriptionState): Promise<void> {
    try {
      await refreshRunsState(client);
    } catch (error) {
      if (client.runsSubscription) {
        sendInternalError(client.socket, error);
      }
    }
  }

  async function sendRunSnapshot(client: ClientSubscriptionState, runId: string): Promise<void> {
    try {
      await refreshRunState(runId, client);
    } catch (error) {
      if (!client.runSubscriptions.delete(runId)) {
        return;
      }
      runResources.get(runId)?.snapshotRequests.delete(client);
      pruneRunResources();
      sendMessage(client.socket, {
        type: "error",
        code: "run_not_found",
        message: error instanceof Error ? error.message : String(error),
        runId,
      });
    }
  }

  function refreshRunsState(snapshotClient?: ClientSubscriptionState): Promise<void> {
    if (snapshotClient) {
      runsResource.snapshotRequests.add(snapshotClient);
    }
    return refreshResource(
      runsResource,
      () => source.getRunsState(),
      (state, version, delta, fromVersion) => {
        for (const client of clients) {
          if (!client.runsSubscription) {
            continue;
          }
          if (
            client.runsSubscription === "pending" ||
            runsResource.snapshotRequests.has(client) ||
            delta.kind === "snapshot"
          ) {
            client.runsSubscription = "active";
            sendMessage(client.socket, { type: "runs_snapshot", version, state });
          } else if (delta.kind === "patch") {
            sendMessage(client.socket, {
              type: "runs_patch",
              fromVersion,
              toVersion: version,
              ops: delta.ops,
            });
          }
        }
      },
    );
  }

  async function refreshRunState(
    runId: string,
    snapshotClient?: ClientSubscriptionState,
  ): Promise<void> {
    const resource: ResourceState<ViewerRunLiveState> = runResources.get(runId) ?? {
      version: 0,
      state: null,
      snapshotRequests: new Set(),
    };
    runResources.set(runId, resource);
    if (snapshotClient) {
      resource.snapshotRequests.add(snapshotClient);
    }
    try {
      await refreshResource(
        resource,
        () => source.getRunState(runId),
        (state, version, delta, fromVersion) => {
          if (runResources.get(runId) !== resource) {
            return;
          }
          for (const client of clients) {
            const subscription = client.runSubscriptions.get(runId);
            if (!subscription) {
              continue;
            }
            if (
              subscription === "pending" ||
              resource.snapshotRequests.has(client) ||
              delta.kind === "snapshot"
            ) {
              client.runSubscriptions.set(runId, "active");
              sendMessage(client.socket, { type: "run_snapshot", runId, version, state });
            } else if (delta.kind === "patch") {
              sendMessage(client.socket, {
                type: "run_patch",
                runId,
                fromVersion,
                toVersion: version,
                ops: delta.ops,
              });
            }
          }
        },
      );
    } catch (error) {
      if (runResources.get(runId) === resource) {
        throw error;
      }
    }
  }

  function refreshPollingState(): void {
    const shouldPoll = hasRunsSubscribers() || getSubscribedRunIds().size > 0;
    if (shouldPoll && pollTimer == null) {
      pollTimer = setInterval(() => {
        void syncResources();
      }, pollIntervalMs);
      pollTimer.unref?.();
      void syncResources();
      return;
    }
    if (!shouldPoll && pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function syncResources(): Promise<void> {
    if (syncing) {
      return;
    }
    syncing = true;

    try {
      if (hasRunsSubscribers()) {
        await refreshRunsState();
      }

      for (const runId of getSubscribedRunIds()) {
        try {
          await refreshRunState(runId);
        } catch (error) {
          for (const client of clients) {
            if (!client.runSubscriptions.has(runId)) {
              continue;
            }
            client.runSubscriptions.delete(runId);
            sendMessage(client.socket, {
              type: "error",
              code: "run_not_found",
              message: error instanceof Error ? error.message : String(error),
              runId,
            });
          }
          runResources.delete(runId);
        }
      }

      pruneRunResources();
      refreshPollingState();
    } catch (error) {
      for (const client of clients) {
        if (client.runsSubscription) {
          sendInternalError(client.socket, error);
        }
      }
    } finally {
      syncing = false;
    }
  }

  function pruneRunResources(): void {
    const activeRunIds = getSubscribedRunIds();
    for (const runId of runResources.keys()) {
      if (!activeRunIds.has(runId)) {
        runResources.delete(runId);
      }
    }
  }

  function hasRunsSubscribers(): boolean {
    for (const client of clients) {
      if (client.runsSubscription) {
        return true;
      }
    }
    return false;
  }

  function getSubscribedRunIds(): Set<string> {
    const runIds = new Set<string>();
    for (const client of clients) {
      for (const runId of client.runSubscriptions.keys()) {
        runIds.add(runId);
      }
    }
    return runIds;
  }

  function handleUpgrade(
    request: http.IncomingMessage,
    socket: net.Socket | Duplex,
    head: Buffer,
  ): boolean {
    if (request.url !== "/api/live") {
      return false;
    }

    server.handleUpgrade(request, socket, head, (ws) => {
      server.emit("connection", ws, request);
    });
    return true;
  }

  async function close(): Promise<void> {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const client of clients) {
      client.socket.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    handleUpgrade,
    close,
  };
}

function refreshResource<TState extends object>(
  resource: ResourceState<TState>,
  read: () => Promise<TState>,
  publish: (
    state: TState,
    version: number,
    delta: ResourceDelta<TState>,
    fromVersion: number,
  ) => void,
): Promise<void> {
  if (resource.pending) {
    return resource.pending;
  }
  resource.pending = (async () => {
    const next = await read();
    const delta: ResourceDelta<TState> =
      resource.state === null
        ? { kind: "snapshot", state: next }
        : computeResourceDelta(resource.state, next);
    const fromVersion = resource.version;
    resource.state = next;
    if (delta.kind !== "noop") {
      resource.version += 1;
    }
    publish(next, resource.version, delta, fromVersion);
    resource.snapshotRequests.clear();
  })().finally(() => {
    resource.pending = undefined;
  });
  return resource.pending;
}

function sendMessage(socket: WebSocket, message: ReplayServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function sendInternalError(socket: WebSocket, error: unknown): void {
  sendMessage(socket, {
    type: "error",
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  });
}
