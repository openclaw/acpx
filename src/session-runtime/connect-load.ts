import type { AcpClient } from "../client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../error-normalization.js";
import { SessionModeReplayError } from "../errors.js";
import { incrementPerfCounter } from "../perf-metrics.js";
import { isProcessAlive } from "../queue-ipc.js";
import type { QueueOwnerActiveSessionController } from "../queue-owner-turn-controller.js";
import { getDesiredModeId } from "../session-mode-preference.js";
import { InterruptedError, TimeoutError, withTimeout } from "../session-runtime-helpers.js";
import type { SessionRecord } from "../types.js";
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

// JSON-RPC codes that indicate the agent does not support session/load.
// -32601 = Method not found, -32602 = Invalid params.
const SESSION_LOAD_UNSUPPORTED_CODES = new Set([-32601, -32602]);

function shouldFallbackToNewSession(error: unknown, record: SessionRecord): boolean {
  if (error instanceof TimeoutError || error instanceof InterruptedError) {
    return false;
  }

  if (isAcpResourceNotFoundError(error)) {
    return true;
  }

  const acp = extractAcpError(error);
  if (acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code)) {
    return true;
  }

  // Some adapters return JSON-RPC internal errors when trying to
  // load sessions that have never produced an agent turn yet.
  if (!sessionHasAgentMessages(record)) {
    if (isAcpQueryClosedBeforeResponseError(error)) {
      return true;
    }

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
  const originalSessionId = record.acpSessionId;
  const originalAgentSessionId = record.agentSessionId;
  const desiredModeId = getDesiredModeId(record.acpx);
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

  const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
  if (reusingLoadedSession) {
    incrementPerfCounter("runtime.connect_and_load.reused_session");
  } else {
    await withTimeout(client.start(), options.timeoutMs);
  }
  options.onClientAvailable?.(options.activeController);
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;
  let createdFreshSession = false;
  let pendingAgentSessionId = record.agentSessionId;

  if (reusingLoadedSession) {
    resumed = true;
  } else if (client.supportsLoadSession()) {
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
      const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
      sessionId = createdSession.sessionId;
      createdFreshSession = true;
      pendingAgentSessionId = createdSession.agentSessionId;
    }
  } else {
    const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    createdFreshSession = true;
    pendingAgentSessionId = createdSession.agentSessionId;
  }

  if (createdFreshSession && desiredModeId) {
    try {
      await withTimeout(client.setSessionMode(sessionId, desiredModeId), options.timeoutMs);
      if (options.verbose) {
        process.stderr.write(
          `[acpx] replayed desired mode ${desiredModeId} on fresh ACP session ${sessionId} (previous ${originalSessionId})\n`,
        );
      }
    } catch (error) {
      const message =
        `Failed to replay saved session mode ${desiredModeId} on fresh ACP session ${sessionId}: ` +
        formatErrorMessage(error);
      record.acpSessionId = originalSessionId;
      record.agentSessionId = originalAgentSessionId;
      if (options.verbose) {
        process.stderr.write(`[acpx] ${message}\n`);
      }
      throw new SessionModeReplayError(message, {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      });
    }
  }

  if (createdFreshSession) {
    record.acpSessionId = sessionId;
    reconcileAgentSessionId(record, pendingAgentSessionId);
  }

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}
