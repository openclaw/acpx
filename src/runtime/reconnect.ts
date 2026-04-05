import type { AcpClient } from "../client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../error-normalization.js";
import {
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../errors.js";
import { incrementPerfCounter } from "../perf-metrics.js";
import {
  getDesiredModeId,
  getDesiredModelId,
  setCurrentModelId,
  syncAdvertisedModelState,
} from "../session-mode-preference.js";
import { InterruptedError, TimeoutError, withTimeout } from "../session-runtime-helpers.js";
import type { SessionRecord, SessionResumePolicy } from "../types.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "./lifecycle.js";

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string) => Promise<void>;
};

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ConnectAndLoadSessionOptions = {
  client: AcpClient;
  record: SessionRecord;
  resumePolicy?: SessionResumePolicy;
  timeoutMs?: number;
  verbose?: boolean;
  activeController: ActiveSessionController;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onSessionIdResolved?: (sessionId: string) => void;
};

export type ConnectAndLoadSessionResult = {
  sessionId: string;
  agentSessionId?: string;
  resumed: boolean;
  loadError?: string;
};

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

function requiresSameSession(resumePolicy: SessionResumePolicy | undefined): boolean {
  return resumePolicy === "same-session-only";
}

function makeSessionResumeRequiredError(params: {
  record: SessionRecord;
  reason: string;
  cause?: unknown;
}): SessionResumeRequiredError {
  return new SessionResumeRequiredError(
    `Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`,
    {
      cause: params.cause instanceof Error ? params.cause : undefined,
    },
  );
}

async function replayDesiredMode(params: {
  client: AcpClient;
  sessionId: string;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<void> {
  const desiredModeId = getDesiredModeId(params.record.acpx);
  if (!desiredModeId) {
    return;
  }
  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, desiredModeId),
      params.timeoutMs,
    );
  } catch (error) {
    throw new SessionModeReplayError(
      `Failed to restore session mode "${desiredModeId}": ${formatErrorMessage(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

async function replayDesiredModel(params: {
  client: AcpClient;
  sessionId: string;
  record: SessionRecord;
  models: import("../client.js").SessionLoadResult["models"] | undefined;
  timeoutMs?: number;
}): Promise<void> {
  const desiredModelId = getDesiredModelId(params.record.acpx);
  if (!desiredModelId || !params.models) {
    return;
  }
  if (params.models.currentModelId === desiredModelId) {
    setCurrentModelId(params.record, desiredModelId);
    return;
  }
  try {
    await withTimeout(
      params.client.setSessionModel(params.sessionId, desiredModelId),
      params.timeoutMs,
    );
    setCurrentModelId(params.record, desiredModelId);
  } catch (error) {
    throw new SessionModelReplayError(
      `Failed to restore session model "${desiredModelId}": ${formatErrorMessage(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function updateLifecycleSnapshot(record: SessionRecord, client: AcpClient): void {
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
}

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const sameSessionOnly = requiresSameSession(options.resumePolicy);
  const originalAgentSessionId = record.agentSessionId;
  const desiredModeId = getDesiredModeId(record.acpx);
  const desiredModelId = getDesiredModelId(record.acpx);
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
  updateLifecycleSnapshot(record, client);
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;
  let createdFreshSession = false;
  let pendingAgentSessionId = record.agentSessionId;
  let sessionModels: import("../client.js").SessionLoadResult["models"];

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
      sessionModels = loadResult.models;
      resumed = true;
    } catch (error) {
      loadError = formatErrorMessage(error);
      if (sameSessionOnly) {
        throw makeSessionResumeRequiredError({
          record,
          reason: loadError,
          cause: error,
        });
      }
      if (!shouldFallbackToNewSession(error, record)) {
        throw error;
      }
      const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
      sessionId = createdSession.sessionId;
      createdFreshSession = true;
      pendingAgentSessionId = createdSession.agentSessionId;
      sessionModels = createdSession.models;
    }
  } else {
    if (sameSessionOnly) {
      throw makeSessionResumeRequiredError({
        record,
        reason: "agent does not support session/load",
      });
    }
    const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    createdFreshSession = true;
    pendingAgentSessionId = createdSession.agentSessionId;
    sessionModels = createdSession.models;
  }

  if (createdFreshSession) {
    record.acpSessionId = sessionId;
    reconcileAgentSessionId(record, pendingAgentSessionId);
  }

  syncAdvertisedModelState(record, sessionModels);
  if (createdFreshSession && desiredModeId) {
    await replayDesiredMode({
      client,
      sessionId,
      record,
      timeoutMs: options.timeoutMs,
    });
  }
  if (
    createdFreshSession &&
    desiredModelId &&
    sessionModels &&
    desiredModelId !== sessionModels.currentModelId
  ) {
    await replayDesiredModel({
      client,
      sessionId,
      record,
      models: sessionModels,
      timeoutMs: options.timeoutMs,
    });
  }
  if (createdFreshSession && desiredModelId && sessionModels) {
    setCurrentModelId(record, desiredModelId);
  }

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId ?? originalAgentSessionId,
    resumed,
    loadError,
  };
}
