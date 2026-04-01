import type http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createReplayPatch } from "../src/lib/json-patch-plus.js";
import type {
  ReplayClientMessage,
  ReplayJsonPatchOperation,
  ReplayProtocol,
  ReplayServerMessage,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../src/types.js";
import type { ViewerRunSource } from "./live-source.js";

const PROTOCOL: ReplayProtocol = "acpx.replay.v1";
const DEFAULT_POLL_INTERVAL_MS = 50;

type ReplayLiveSyncOptions = {
  source: ViewerRunSource;
  pollIntervalMs?: number;
};

type ResourceState<TState> = {
  version: number;
  state: TState | null;
};

type ResourceDelta<TState> =
  | { kind: "noop" }
  | { kind: "patch"; ops: ReplayJsonPatchOperation[] }
  | { kind: "snapshot"; state: TState };

type ClientSubscriptionState = {
  socket: WebSocket;
  wantsRuns: boolean;
  runIds: Set<string>;
};

export type ReplayLiveSyncServer = {
  handleUpgrade(
    request: http.IncomingMessage,
    socket: net.Socket | Duplex,
    head: Buffer,
  ): Promise<boolean>;
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
  };
  const runResources = new Map<string, ResourceState<ViewerRunLiveState>>();
  let pollTimer: NodeJS.Timeout | null = null;
  let syncing = false;

  server.on("connection", (socket) => {
    const client: ClientSubscriptionState = {
      socket,
      wantsRuns: false,
      runIds: new Set<string>(),
    };
    clients.add(client);
    sendMessage(socket, {
      type: "ready",
      protocol: PROTOCOL,
    });

    socket.on("message", (data) => {
      void handleMessage(client, data);
    });
    socket.on("close", () => {
      clients.delete(client);
      pruneRunResources();
      refreshPollingState();
    });
  });

  async function handleMessage(client: ClientSubscriptionState, data: RawData): Promise<void> {
    let message: ReplayClientMessage;
    try {
      message = JSON.parse(decodeMessage(data)) as ReplayClientMessage;
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
            message: `Unsupported replay protocol: ${message.protocol}`,
          });
        }
        return;
      case "ping":
        sendMessage(client.socket, { type: "pong" });
        return;
      case "subscribe_runs":
      case "resync_runs":
        client.wantsRuns = true;
        await sendRunsSnapshot(client);
        refreshPollingState();
        return;
      case "unsubscribe_runs":
        client.wantsRuns = false;
        refreshPollingState();
        return;
      case "subscribe_run":
      case "resync_run":
        client.runIds.add(message.runId);
        await sendRunSnapshot(client, message.runId);
        refreshPollingState();
        return;
      case "unsubscribe_run":
        client.runIds.delete(message.runId);
        pruneRunResources();
        refreshPollingState();
        return;
      default:
        sendMessage(client.socket, {
          type: "error",
          code: "protocol_error",
          message: `Unsupported replay viewer message: ${JSON.stringify(message)}`,
        });
    }
  }

  async function sendRunsSnapshot(client: ClientSubscriptionState): Promise<void> {
    try {
      const resource = await refreshRunsState();
      sendMessage(client.socket, {
        type: "runs_snapshot",
        version: resource.version,
        state: resource.state,
      });
    } catch (error) {
      sendInternalError(client.socket, error);
    }
  }

  async function sendRunSnapshot(client: ClientSubscriptionState, runId: string): Promise<void> {
    try {
      const resource = await refreshRunState(runId);
      sendMessage(client.socket, {
        type: "run_snapshot",
        runId,
        version: resource.version,
        state: resource.state,
      });
    } catch (error) {
      client.runIds.delete(runId);
      sendMessage(client.socket, {
        type: "error",
        code: "run_not_found",
        message: error instanceof Error ? error.message : String(error),
        runId,
      });
    }
  }

  async function ensureRunsState(): Promise<{ version: number; state: ViewerRunsState }> {
    if (runsResource.state == null) {
      runsResource.state = await source.getRunsState();
      runsResource.version = 1;
    }
    return {
      version: runsResource.version,
      state: runsResource.state,
    };
  }

  async function refreshRunsState(): Promise<{ version: number; state: ViewerRunsState }> {
    const nextState = await source.getRunsState();

    if (runsResource.state == null) {
      runsResource.state = nextState;
      runsResource.version = 1;
    } else {
      const delta = computeResourceDelta(runsResource.state, nextState);
      if (delta.kind !== "noop") {
        runsResource.version += 1;
        runsResource.state = nextState;
      }
    }

    return {
      version: runsResource.version,
      state: runsResource.state,
    };
  }

  async function ensureRunState(
    runId: string,
  ): Promise<{ version: number; state: ViewerRunLiveState }> {
    const resource = runResources.get(runId) ?? { version: 0, state: null };
    if (resource.state == null) {
      resource.state = await source.getRunState(runId);
      resource.version = 1;
      runResources.set(runId, resource);
    }
    return {
      version: resource.version,
      state: resource.state,
    };
  }

  async function refreshRunState(
    runId: string,
  ): Promise<{ version: number; state: ViewerRunLiveState }> {
    const resource = runResources.get(runId) ?? { version: 0, state: null };
    const nextState = await source.getRunState(runId);

    if (resource.state == null) {
      resource.state = nextState;
      resource.version = 1;
    } else {
      const delta = computeResourceDelta(resource.state, nextState);
      if (delta.kind !== "noop") {
        resource.version += 1;
        resource.state = nextState;
      }
    }

    runResources.set(runId, resource);
    return {
      version: resource.version,
      state: resource.state,
    };
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
        const resource = await ensureRunsState();
        const nextState = await source.getRunsState();
        const delta = computeResourceDelta(resource.state, nextState);
        if (delta.kind !== "noop") {
          const fromVersion = runsResource.version;
          runsResource.version += 1;
          runsResource.state = nextState;
          if (delta.kind === "patch") {
            broadcast((client) => client.wantsRuns, {
              type: "runs_patch",
              fromVersion,
              toVersion: runsResource.version,
              ops: delta.ops,
            });
          } else {
            broadcast((client) => client.wantsRuns, {
              type: "runs_snapshot",
              version: runsResource.version,
              state: nextState,
            });
          }
        }
      }

      for (const runId of getSubscribedRunIds()) {
        try {
          const resource = await ensureRunState(runId);
          const nextState = await source.getRunState(runId);
          const delta = computeResourceDelta(resource.state, nextState);
          if (delta.kind === "noop") {
            continue;
          }
          const fromVersion = resource.version;
          resource.version += 1;
          resource.state = nextState;
          runResources.set(runId, resource);
          if (delta.kind === "patch") {
            broadcast((client) => client.runIds.has(runId), {
              type: "run_patch",
              runId,
              fromVersion,
              toVersion: resource.version,
              ops: delta.ops,
            });
          } else {
            broadcast((client) => client.runIds.has(runId), {
              type: "run_snapshot",
              runId,
              version: resource.version,
              state: nextState,
            });
          }
        } catch (error) {
          for (const client of clients) {
            if (!client.runIds.has(runId)) {
              continue;
            }
            client.runIds.delete(runId);
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
      if (client.wantsRuns) {
        return true;
      }
    }
    return false;
  }

  function getSubscribedRunIds(): Set<string> {
    const runIds = new Set<string>();
    for (const client of clients) {
      for (const runId of client.runIds) {
        runIds.add(runId);
      }
    }
    return runIds;
  }

  function broadcast(
    predicate: (client: ClientSubscriptionState) => boolean,
    message: ReplayServerMessage,
  ): void {
    for (const client of clients) {
      if (predicate(client)) {
        sendMessage(client.socket, message);
      }
    }
  }

  async function handleUpgrade(
    request: http.IncomingMessage,
    socket: net.Socket | Duplex,
    head: Buffer,
  ): Promise<boolean> {
    if (request.url !== "/api/live") {
      return false;
    }

    await new Promise<void>((resolve) => {
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit("connection", ws, request);
        resolve();
      });
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

function decodeMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data.toString("utf8");
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
