import { AcpClient, type SessionCreateResult } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { setCurrentModelId, syncAdvertisedModelState } from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
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
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";
import { setSessionModel } from "./session-control.js";

async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  await withTimeout(client.start(), options.timeoutMs);
  let sessionId: string;
  let agentSessionId: string | undefined;
  let sessionResult: Awaited<ReturnType<AcpClient["createSession" | "loadSession"]>>;
  let sessionModels: SessionCreateResult["models"];
  let requestedModelApplied = false;

  if (options.resumeSessionId) {
    const resumed = await resumeSessionRecordWithClient(client, options, cwd);
    sessionId = resumed.sessionId;
    agentSessionId = resumed.agentSessionId;
    sessionResult = resumed.sessionResult;
    sessionModels = resumed.sessionModels;
    requestedModelApplied = resumed.requestedModelApplied;
  } else {
    const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
    sessionResult = createdSession;
    sessionModels = createdSession.models;
    requestedModelApplied = await applyRequestedModelIfAdvertised({
      client,
      sessionId,
      requestedModel: options.sessionOptions?.model,
      models: sessionModels,
      agentCommand: options.agentCommand,
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
  applyConfigOptionsToRecord(record, sessionResult);
  syncAdvertisedModelState(record, sessionModels);
  if (requestedModelApplied) {
    setCurrentModelId(record, options.sessionOptions?.model);
  }

  await writeSessionRecord(record);
  return record;
}

type CreatedSessionState = {
  sessionId: string;
  agentSessionId: string | undefined;
  sessionResult: Awaited<ReturnType<AcpClient["createSession" | "loadSession"]>>;
  sessionModels: SessionCreateResult["models"];
  requestedModelApplied: boolean;
};

async function resumeSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  if (!options.resumeSessionId) {
    throw new Error("resumeSessionId is required");
  }
  const resumeMethod = client.supportsResumeSession()
    ? "session/resume"
    : client.supportsLoadSession()
      ? "session/load"
      : undefined;
  if (!resumeMethod) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not support session/resume or session/load; cannot resume session ${options.resumeSessionId}`,
    );
  }

  try {
    const resumedSession = await withTimeout(
      resumeMethod === "session/resume"
        ? client.resumeSession(options.resumeSessionId, cwd)
        : client.loadSession(options.resumeSessionId, cwd),
      options.timeoutMs,
    );
    const sessionModels = resumedSession.models;
    return {
      sessionId: options.resumeSessionId,
      agentSessionId: normalizeRuntimeSessionId(resumedSession.agentSessionId),
      sessionResult: resumedSession,
      sessionModels,
      requestedModelApplied: await applyRequestedModelIfAdvertised({
        client,
        sessionId: options.resumeSessionId,
        requestedModel: options.sessionOptions?.model,
        models: sessionModels,
        agentCommand: options.agentCommand,
        timeoutMs: options.timeoutMs,
      }),
    };
  } catch (error) {
    throw new Error(
      `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
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
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
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

export async function listAgentSessions(options: SessionListOptions): Promise<SessionListResult> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        if (!client.supportsListSessions()) {
          return undefined;
        }

        const cwd = options.filterCwd ? absolutePath(options.filterCwd) : undefined;
        const response = await withTimeout(
          client.listSessions({
            ...(cwd ? { cwd } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
          options.timeoutMs,
        );

        return {
          _meta: response._meta,
          source: "agent",
          sessions: response.sessions,
          cursor: options.cursor,
          cwd,
          nextCursor: response.nextCursor,
        };
      },
      async () => {
        await client.close();
      },
    );
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
        terminal: options.terminal,
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
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
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
