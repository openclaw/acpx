import { AcpClient, type SessionCreateResult } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { setCurrentModelId, syncAdvertisedModelState } from "../../session/mode-preference.js";
import {
  absolutePath,
  findGitRepositoryRoot,
  findSessionByDirectoryWalk,
  isoNow,
  normalizeName,
  writeSessionRecord,
} from "../../session/persistence.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { SessionEnsureResult, SessionRecord } from "../../types.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  SessionAgentOptions,
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
} from "./contracts.js";
import { setSessionModel } from "./session-control.js";

function persistSessionOptions(
  record: SessionRecord,
  options: SessionAgentOptions | undefined,
): void {
  const next =
    options &&
    ({
      model: typeof options.model === "string" ? options.model : undefined,
      allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : undefined,
      max_turns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
    } satisfies NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>);

  const hasValues = Boolean(
    next &&
    ((typeof next.model === "string" && next.model.trim().length > 0) ||
      (Array.isArray(next.allowed_tools) && next.allowed_tools.length > 0) ||
      typeof next.max_turns === "number"),
  );

  if (hasValues && next) {
    record.acpx = {
      ...record.acpx,
      session_options: next,
    };
    return;
  }

  if (!record.acpx) {
    return;
  }

  delete record.acpx.session_options;
}

async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  timeoutMs?: number;
}): Promise<boolean> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel || !params.models) {
    return false;
  }
  if (params.models.currentModelId === requestedModel) {
    return true;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  return true;
}

async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  await withTimeout(client.start(), options.timeoutMs);
  let sessionId: string;
  let agentSessionId: string | undefined;
  let sessionModels: SessionCreateResult["models"];
  let requestedModelApplied = false;

  if (options.resumeSessionId) {
    if (!client.supportsLoadSession()) {
      throw new Error(
        `Agent command "${options.agentCommand}" does not support session/load; cannot resume session ${options.resumeSessionId}`,
      );
    }

    try {
      const loadedSession = await withTimeout(
        client.loadSession(options.resumeSessionId, cwd),
        options.timeoutMs,
      );
      sessionId = options.resumeSessionId;
      agentSessionId = normalizeRuntimeSessionId(loadedSession.agentSessionId);
      sessionModels = loadedSession.models;
      requestedModelApplied = await applyRequestedModelIfAdvertised({
        client,
        sessionId,
        requestedModel: options.sessionOptions?.model,
        models: sessionModels,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      throw new Error(
        `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  } else {
    const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
    sessionModels = createdSession.models;
    requestedModelApplied = await applyRequestedModelIfAdvertised({
      client,
      sessionId,
      requestedModel: options.sessionOptions?.model,
      models: sessionModels,
      timeoutMs: options.timeoutMs,
    });
  }

  const lifecycle = client.getAgentLifecycleSnapshot();
  const now = isoNow();
  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentSessionId,
    agentCommand: options.agentCommand,
    cwd,
    name: normalizeName(options.name),
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(sessionId),
    closed: false,
    closedAt: undefined,
    pid: lifecycle.pid,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
    ...createSessionConversation(now),
    acpx: {},
  };

  persistSessionOptions(record, options.sessionOptions);
  syncAdvertisedModelState(record, sessionModels);
  if (requestedModelApplied) {
    setCurrentModelId(record, options.sessionOptions?.model);
  }

  await writeSessionRecord(record);
  return record;
}

export async function createSessionWithClient(
  options: SessionCreateOptions,
): Promise<SessionCreateWithClientResult> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  try {
    const record = await withInterrupt(
      async () => await createSessionRecordWithClient(client, options),
      async () => {
        await client.close();
      },
    );

    return {
      record,
      client,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const { record, client } = await createSessionWithClient(options);
  try {
    return record;
  } finally {
    await client.close();
  }
}

export async function ensureSession(options: SessionEnsureOptions): Promise<SessionEnsureResult> {
  const cwd = absolutePath(options.cwd);
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = options.walkBoundary ?? gitRoot ?? cwd;
  const existing = await findSessionByDirectoryWalk({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });
  if (existing) {
    const requestedModel = options.sessionOptions?.model;
    if (requestedModel) {
      const result = await setSessionModel({
        sessionId: existing.acpxRecordId,
        modelId: requestedModel,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });
      return { record: result.record, created: false };
    }
    return {
      record: existing,
      created: false,
    };
  }

  const record = await createSession({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    resumeSessionId: options.resumeSessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  return {
    record,
    created: true,
  };
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
