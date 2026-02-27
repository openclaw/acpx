import type { AcpClient } from "../client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../error-normalization.js";
import {
  InterruptedError,
  TimeoutError,
  withTimeout,
} from "../session-runtime-helpers.js";
import { isProcessAlive } from "../queue-ipc.js";
import { writeSessionRecord } from "../session-persistence.js";
import type { SessionRecord } from "../types.js";
import type { QueueOwnerActiveSessionController } from "../queue-owner-turn-controller.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "./lifecycle.js";

export type ConnectAndLoadSessionOptions = {
  client: AcpClient;
  record: SessionRecord;
  timeoutMs?: number;
  verbose?: boolean;
  activeController: QueueOwnerActiveSessionController;
  onClientAvailable?: (controller: QueueOwnerActiveSessionController) => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onSessionIdResolved?: (sessionId: string) => void;
};

export type ConnectAndLoadSessionResult = {
  sessionId: string;
  agentSessionId?: string;
  resumed: boolean;
  loadError?: string;
};

function shouldFallbackToNewSession(error: unknown, record: SessionRecord): boolean {
  if (error instanceof TimeoutError || error instanceof InterruptedError) {
    return false;
  }

  if (isAcpResourceNotFoundError(error)) {
    return true;
  }

  // Some adapters return JSON-RPC internal errors when trying to
  // load sessions that have never produced an agent turn yet.
  if (!sessionHasAgentMessages(record)) {
    if (isAcpQueryClosedBeforeResponseError(error)) {
      return true;
    }

    const acp = extractAcpError(error);
    if (acp?.code === -32603) {
      return true;
    }
  }

  return false;
}

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  if (options.verbose) {
    if (storedProcessAlive) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`,
      );
    } else if (shouldReconnect) {
      process.stderr.write(
        `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session/load\n`,
      );
    }
  }

  await withTimeout(client.start(), options.timeoutMs);
  options.onClientAvailable?.(options.activeController);
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);
  await writeSessionRecord(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;

  if (client.supportsLoadSession()) {
    try {
      const loadResult = await withTimeout(
        client.loadSessionWithOptions(record.acpSessionId, record.cwd, {
          suppressReplayUpdates: true,
        }),
        options.timeoutMs,
      );
      reconcileAgentSessionId(record, loadResult.agentSessionId);
      resumed = true;
    } catch (error) {
      loadError = formatErrorMessage(error);
      if (!shouldFallbackToNewSession(error, record)) {
        throw error;
      }
      const createdSession = await withTimeout(
        client.createSession(record.cwd),
        options.timeoutMs,
      );
      sessionId = createdSession.sessionId;
      record.acpSessionId = sessionId;
      reconcileAgentSessionId(record, createdSession.agentSessionId);
    }
  } else {
    const createdSession = await withTimeout(
      client.createSession(record.cwd),
      options.timeoutMs,
    );
    sessionId = createdSession.sessionId;
    record.acpSessionId = sessionId;
    reconcileAgentSessionId(record, createdSession.agentSessionId);
  }

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}
