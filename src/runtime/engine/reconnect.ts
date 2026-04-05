import type { AcpClient } from "../../acp/client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../../acp/error-normalization.js";
import { InterruptedError, TimeoutError, withTimeout } from "../../async-control.js";
import {
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import {
  getDesiredModeId,
  getDesiredModelId,
  setCurrentModelId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import type { SessionRecord, SessionResumePolicy } from "../../types.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "./lifecycle.js";

export type ConnectedSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
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
  activeController: ConnectedSessionController;
  onClientAvailable?: (controller: ConnectedSessionController) => void;
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
  desiredModeId: string | undefined;
  previousSessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModeId) {
    return;
  }

  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, params.desiredModeId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModeReplayError(
      `Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

async function replayDesiredModel(params: {
  client: AcpClient;
  sessionId: string;
  desiredModelId: string | undefined;
  previousSessionId: string;
  models: import("../../acp/client.js").SessionLoadResult["models"] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModelId || !params.models) {
    return;
  }
  if (params.models.currentModelId === params.desiredModelId) {
    return;
  }

  try {
    await withTimeout(
      params.client.setSessionModel(params.sessionId, params.desiredModelId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired model ${params.desiredModelId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModelReplayError(
      `Failed to replay saved session model ${params.desiredModelId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

function restoreOriginalSessionState(params: {
  record: SessionRecord;
  sessionId: string;
  agentSessionId: string | undefined;
}): void {
  params.record.acpSessionId = params.sessionId;
  params.record.agentSessionId = params.agentSessionId;
}

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const sameSessionOnly = requiresSameSession(options.resumePolicy);
  const originalSessionId = record.acpSessionId;
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
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;
  let createdFreshSession = false;
  let pendingAgentSessionId = record.agentSessionId;
  let sessionModels: import("../../acp/client.js").SessionLoadResult["models"];

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
    try {
      await replayDesiredMode({
        client,
        sessionId,
        desiredModeId,
        previousSessionId: originalSessionId,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });
      await replayDesiredModel({
        client,
        sessionId,
        desiredModelId,
        previousSessionId: originalSessionId,
        models: sessionModels,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });
    } catch (error) {
      restoreOriginalSessionState({
        record,
        sessionId: originalSessionId,
        agentSessionId: originalAgentSessionId,
      });
      if (options.verbose) {
        process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
      }
      throw error;
    }

    record.acpSessionId = sessionId;
    reconcileAgentSessionId(record, pendingAgentSessionId);
  }

  syncAdvertisedModelState(record, sessionModels);
  if (createdFreshSession && desiredModelId && sessionModels) {
    setCurrentModelId(record, desiredModelId);
  }

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}
