import { normalizeAgentSessionId } from "../../acp/agent-session-id.js";
import { AcpClient } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { assertControlAuthority, withInterrupt, withTimeout } from "../../async-control.js";
import {
  applyLifecycleSnapshotToRecord,
  createInitialSessionRecord,
} from "../../runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import type { SessionEnsureResult, SessionRecord } from "../../types.js";
import { applyConfigOptionsToRecord, applyInitialModelSelection } from "../config-options.js";
import { applyRequestedModelIfAdvertised } from "../model-application.js";
import {
  absolutePath,
  findGitRepositoryRoot,
  findSessionByDirectoryWalk,
  normalizeName,
  writeSessionRecord,
} from "../persistence.js";
import { acquireSessionScope } from "../turn-ownership.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";
import { directExecutionError, ownDirectClient } from "./direct-lifetime.js";
import { setSessionModel } from "./session-control.js";

type CreatedSessionState = {
  sessionId: string;
  agentSessionId: string | undefined;
  sessionResult: Awaited<ReturnType<AcpClient["createSession" | "loadSession"]>>;
  modelApplication: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>;
};

async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  await withTimeout(client.start({ signal: options.signal }), options.timeoutMs);
  assertControlAuthority({ signal: options.signal });
  const createdState = options.resumeSessionId
    ? await resumeSessionRecordWithClient(client, options, cwd)
    : await createFreshSessionState(client, options, cwd);
  const { sessionId, agentSessionId } = createdState;
  assertControlAuthority({ signal: options.signal });

  const lifecycle = client.getAgentLifecycleSnapshot();
  const record: SessionRecord = {
    ...createInitialSessionRecord({
      recordId: sessionId,
      sessionId,
      agentSessionId,
      agentCommand: options.agentCommand,
      agentArgv: options.agentArgv,
      cwd,
      name: normalizeName(options.name),
    }),
    lastRequestId: undefined,
    pid: lifecycle.running ? lifecycle.pid : undefined,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
  };

  persistSessionOptions(record, options.sessionOptions);
  applyConfigOptionsToRecord(record, createdState.sessionResult);
  applyInitialModelSelection(
    record,
    createdState.sessionResult.models,
    createdState.modelApplication,
  );

  await writeSessionRecord(record);
  assertControlAuthority({ signal: options.signal });
  return record;
}

async function createFreshSessionState(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  const createdSession = await withTimeout(
    client.createSession(cwd, { signal: options.signal }),
    options.timeoutMs,
  );
  assertControlAuthority({ signal: options.signal });
  const modelApplication = await applyRequestedModelIfAdvertised({
    client,
    sessionId: createdSession.sessionId,
    requestedModel: options.sessionOptions?.model,
    models: createdSession.models,
    agentCommand: options.agentCommand,
    timeoutMs: options.timeoutMs,
    onWarning: options.onModelWarning,
    authority: { signal: options.signal },
  });
  return {
    sessionId: createdSession.sessionId,
    agentSessionId: normalizeAgentSessionId(createdSession.agentSessionId),
    sessionResult: createdSession,
    modelApplication,
  };
}

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
        ? client.resumeSession(options.resumeSessionId, cwd, { signal: options.signal })
        : client.loadSessionWithOptions(options.resumeSessionId, cwd, {
            authority: { signal: options.signal },
          }),
      options.timeoutMs,
    );
    const sessionModels = resumedSession.models;
    assertControlAuthority({ signal: options.signal });
    const modelApplication = await applyRequestedModelIfAdvertised({
      client,
      sessionId: options.resumeSessionId,
      requestedModel: options.sessionOptions?.model,
      models: sessionModels,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
      onWarning: options.onModelWarning,
      authority: { signal: options.signal },
    });
    return {
      sessionId: options.resumeSessionId,
      agentSessionId: normalizeAgentSessionId(resumedSession.agentSessionId),
      sessionResult: resumedSession,
      modelApplication,
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
  assertControlAuthority({ signal: options.signal });
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  const closeOwnedClient = ownDirectClient(client, options.signal);
  try {
    const create = async () => {
      assertControlAuthority({ signal: options.signal });
      const record = await createSessionRecordWithClient(client, options);
      assertControlAuthority({ signal: options.signal });
      return record;
    };
    const record =
      options.handleProcessInterrupts === false
        ? await create()
        : await withInterrupt(create, async () => {
            await closeOwnedClient();
          });

    return {
      record,
      client,
    };
  } catch (error) {
    await closeOwnedClient();
    throw directExecutionError(error, options.signal);
  } finally {
    closeOwnedClient.release();
  }
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const { record, client } = await createSessionWithClient(options);
  try {
    return record;
  } finally {
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  }
}

export async function listAgentSessions(options: SessionListOptions): Promise<SessionListResult> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
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
  const ownership = await acquireSessionScope(
    { agentCommand: options.agentCommand, cwd, name: normalizeName(options.name) },
    options.signal,
  );
  try {
    return await ensureSessionWithOwnership(options, cwd);
  } finally {
    await ownership[Symbol.asyncDispose]();
  }
}

async function ensureSessionWithOwnership(
  options: SessionEnsureOptions,
  cwd: string,
): Promise<SessionEnsureResult> {
  assertControlAuthority({ signal: options.signal });
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
        fs: options.fs,
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
    signal: options.signal,
    handleProcessInterrupts: options.handleProcessInterrupts,
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd,
    name: options.name,
    resumeSessionId: options.resumeSessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
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
