import type { AcpClient } from "../../acp/client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../../acp/error-normalization.js";
import { assertRequestedModelSupported } from "../../acp/model-support.js";
import { InterruptedError, TimeoutError, withTimeout } from "../../async-control.js";
import {
  SessionConfigOptionReplayError,
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import {
  getDesiredConfigOptions,
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
  if (isHardReconnectFailure(error)) {
    return false;
  }
  const acp = extractAcpError(error);
  if (isAcpResourceNotFoundError(error) || isUnsupportedSessionLoadAcpError(acp)) {
    return true;
  }

  return !sessionHasAgentMessages(record) && isFallbackSafeEmptySessionError(error, acp);
}

function isHardReconnectFailure(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof InterruptedError;
}

function isUnsupportedSessionLoadAcpError(acp: ReturnType<typeof extractAcpError>): boolean {
  return !!acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code);
}

function isFallbackSafeEmptySessionError(
  error: unknown,
  acp: ReturnType<typeof extractAcpError>,
): boolean {
  return isAcpQueryClosedBeforeResponseError(error) || acp?.code === -32603;
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
  record: SessionRecord;
  models: import("../../acp/client.js").SessionLoadResult["models"] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModelId) {
    return;
  }

  try {
    assertRequestedModelSupported({
      requestedModel: params.desiredModelId,
      models: params.models,
      agentCommand: params.record.agentCommand,
      context: "replay",
    });
    if (!params.models || params.models.currentModelId === params.desiredModelId) {
      return;
    }
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

async function replayDesiredConfigOptions(params: {
  client: AcpClient;
  sessionId: string;
  desiredConfigOptions: Record<string, string>;
  previousSessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  for (const [configId, value] of Object.entries(params.desiredConfigOptions)) {
    try {
      await withTimeout(
        params.client.setSessionConfigOption(params.sessionId, configId, value),
        params.timeoutMs,
      );
      if (params.verbose) {
        process.stderr.write(
          `[acpx] replayed desired config option ${configId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
        );
      }
    } catch (error) {
      throw new SessionConfigOptionReplayError(
        `Failed to replay saved session config option ${configId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
        {
          cause: error instanceof Error ? error : undefined,
          retryable: true,
        },
      );
    }
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
  const desiredConfigOptions = getDesiredConfigOptions(record.acpx);
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  logReconnectAttempt(record, storedProcessAlive, shouldReconnect, options.verbose);

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

  const loadState = await loadOrCreateRuntimeSession({
    client,
    record,
    reusingLoadedSession,
    sameSessionOnly,
    timeoutMs: options.timeoutMs,
  });
  resumed = loadState.resumed;
  loadError = loadState.loadError;
  sessionId = loadState.sessionId;
  createdFreshSession = loadState.createdFreshSession;
  pendingAgentSessionId = loadState.pendingAgentSessionId;
  sessionModels = loadState.sessionModels;

  await replayFreshSessionPreferences({
    client,
    record,
    createdFreshSession,
    sessionId,
    pendingAgentSessionId,
    originalSessionId,
    originalAgentSessionId,
    desiredModeId,
    desiredModelId,
    desiredConfigOptions,
    sessionModels,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });

  applyReconnectedModelState(record, sessionModels, createdFreshSession, desiredModelId);

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}

function applyReconnectedModelState(
  record: SessionRecord,
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"],
  createdFreshSession: boolean,
  desiredModelId: string | undefined,
): void {
  syncAdvertisedModelState(record, sessionModels);
  if (createdFreshSession && desiredModelId && sessionModels) {
    setCurrentModelId(record, desiredModelId);
  }
}

function logReconnectAttempt(
  record: SessionRecord,
  storedProcessAlive: boolean,
  shouldReconnect: boolean,
  verbose: boolean | undefined,
): void {
  if (!verbose) {
    return;
  }
  if (storedProcessAlive) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is running; reconnecting to saved ACP session\n`,
    );
    return;
  }
  if (shouldReconnect) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session reconnect\n`,
    );
  }
}

async function replayFreshSessionPreferences(params: {
  client: AcpClient;
  record: SessionRecord;
  createdFreshSession: boolean;
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  originalSessionId: string;
  originalAgentSessionId: string | undefined;
  desiredModeId: string | undefined;
  desiredModelId: string | undefined;
  desiredConfigOptions: Record<string, string>;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.createdFreshSession) {
    return;
  }

  try {
    await replayDesiredMode({
      client: params.client,
      sessionId: params.sessionId,
      desiredModeId: params.desiredModeId,
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    await replayDesiredModel({
      client: params.client,
      sessionId: params.sessionId,
      desiredModelId: params.desiredModelId,
      previousSessionId: params.originalSessionId,
      record: params.record,
      models: params.sessionModels,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    await replayDesiredConfigOptions({
      client: params.client,
      sessionId: params.sessionId,
      desiredConfigOptions: params.desiredConfigOptions,
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
  } catch (error) {
    restoreOriginalSessionState({
      record: params.record,
      sessionId: params.originalSessionId,
      agentSessionId: params.originalAgentSessionId,
    });
    if (params.verbose) {
      process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
    }
    throw error;
  }

  params.record.acpSessionId = params.sessionId;
  reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
}

type RuntimeSessionLoadState = {
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  resumed: boolean;
  createdFreshSession: boolean;
  loadError?: string;
};

async function loadOrCreateRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  reusingLoadedSession: boolean;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  if (params.reusingLoadedSession) {
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: undefined,
      resumed: true,
      createdFreshSession: false,
    };
  }

  if (params.client.supportsResumeSession()) {
    return await resumeRuntimeSession(params);
  }

  if (params.client.supportsLoadSession()) {
    return await loadRuntimeSession(params);
  }

  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: "agent does not support session/resume or session/load",
    });
  }

  return await createFreshRuntimeSession(params.client, params.record, params.timeoutMs);
}

async function resumeRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  try {
    const resumeResult = await withTimeout(
      params.client.resumeSession(params.record.acpSessionId, params.record.cwd),
      params.timeoutMs,
    );
    reconcileAgentSessionId(params.record, resumeResult.agentSessionId);
    applyConfigOptionsToRecord(params.record, resumeResult);
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: resumeResult.models,
      resumed: true,
      createdFreshSession: false,
    };
  } catch (error) {
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function loadRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  try {
    const loadResult = await withTimeout(
      params.client.loadSessionWithOptions(params.record.acpSessionId, params.record.cwd, {
        suppressReplayUpdates: true,
      }),
      params.timeoutMs,
    );
    reconcileAgentSessionId(params.record, loadResult.agentSessionId);
    applyConfigOptionsToRecord(params.record, loadResult);
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: loadResult.models,
      resumed: true,
      createdFreshSession: false,
    };
  } catch (error) {
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function recoverRuntimeSessionLoadFailure(
  params: {
    client: AcpClient;
    record: SessionRecord;
    sameSessionOnly: boolean;
    timeoutMs?: number;
  },
  error: unknown,
): Promise<RuntimeSessionLoadState> {
  const loadError = formatErrorMessage(error);
  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: loadError,
      cause: error,
    });
  }
  if (!shouldFallbackToNewSession(error, params.record)) {
    throw error;
  }
  return {
    ...(await createFreshRuntimeSession(params.client, params.record, params.timeoutMs)),
    loadError,
  };
}

async function createFreshRuntimeSession(
  client: AcpClient,
  record: SessionRecord,
  timeoutMs: number | undefined,
): Promise<RuntimeSessionLoadState> {
  const createdSession = await withTimeout(client.createSession(record.cwd), timeoutMs);
  applyConfigOptionsToRecord(record, createdSession);
  return {
    sessionId: createdSession.sessionId,
    pendingAgentSessionId: createdSession.agentSessionId,
    sessionModels: createdSession.models,
    resumed: false,
    createdFreshSession: true,
  };
}
