import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionNotification, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeAgentCommandInput } from "../../acp/client-process.js";
import { AcpClient } from "../../acp/client.js";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { extractAcpError, isAcpResourceNotFoundError } from "../../acp/error-shapes.js";
import {
  assertControlAuthority,
  TimeoutError,
  withTimeout,
  type AcpControlAuthority,
} from "../../async-control.js";
import type { PromptInput } from "../../prompt-content.js";
import {
  applyConfigOptionsToRecord,
  applyConfigOptionSelection,
  applyModelSelection,
  applyInitialModelSelection,
} from "../../session/config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import { setDesiredModeId } from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import type { ClientOperation, SessionRecord, SessionResumePolicy } from "../../types.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeSessionContext,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "../public/contract.js";
import { AcpRuntimeError } from "../public/errors.js";
import { parsePromptEventLine } from "../public/events.js";
import { probeRuntime, type RuntimeHealthReport } from "../public/probe.js";
import { withConnectedSession } from "./connected-session.js";
import { resolveSupportedConfigOptionId } from "./controls.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
  createInitialSessionRecord,
  reconcileAgentSessionId,
} from "./lifecycle.js";
import { runPromptTurn } from "./prompt-turn.js";
import {
  connectAndLoadSession,
  type ConnectAndLoadSessionOptions,
  type ConnectAndLoadSessionResult,
} from "./reconnect.js";
import { shouldReuseExistingRecord } from "./reuse-policy.js";
import {
  persistSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "./session-options.js";
import { runtimeStatusFromRecord } from "./status.js";
import {
  AsyncEventQueue,
  createDeferred,
  toPromptInput,
  legacyTerminalEventFromTurnResult,
  type Deferred,
} from "./turn.js";

export type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, authority?: AcpControlAuthority) => Promise<void>;
  setSessionModel: (
    modelId: string,
    authority?: AcpControlAuthority,
  ) => ReturnType<AcpClient["setSessionModel"]>;
  setSessionConfigOption: (
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
  setResolvedSessionConfigOption: (
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ) => Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }>;
};

type SettledAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
type FailedAttempt = Extract<SettledAttempt<unknown>, { ok: false }>;

async function settleAttempt<T>(run: () => T | Promise<T>): Promise<SettledAttempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function firstFailedAttempt(
  attempts: readonly SettledAttempt<unknown>[],
): FailedAttempt | undefined {
  return attempts.find((attempt): attempt is FailedAttempt => !attempt.ok);
}

function isoNow(): string {
  return new Date().toISOString();
}

function isUnsupportedSessionCloseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp) {
    return false;
  }
  if (acp.code === -32601 || acp.code === -32602) {
    return true;
  }
  if (acp.code !== -32603 || !acp.data || typeof acp.data !== "object") {
    return false;
  }
  const details = (acp.data as { details?: unknown }).details;
  return typeof details === "string" && details.toLowerCase().includes("invalid params");
}

function createRecordId(sessionKey: string, mode: "persistent" | "oneshot"): string {
  if (mode === "persistent") {
    return sessionKey;
  }
  return `${sessionKey}:oneshot:${randomUUID()}`;
}

function resumePolicyForSessionMode(mode: "persistent" | "oneshot"): SessionResumePolicy {
  return mode === "persistent" ? "same-session-only" : "allow-new";
}

// A peer that never answers `initialize` (for example a one-shot runner waiting for a prompt on
// stdin) must not leave session creation pending. The caller's teardown closes the client, which
// stops the agent together with the descendants it has forked.
async function startRuntimeClient(
  client: AcpClient,
  agent: { agentCommand: string; agentArgv?: string[] },
  timeoutMs: number | undefined,
): Promise<void> {
  try {
    await withTimeout(client.start(), timeoutMs);
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      throw error;
    }
    // Name only the executable: configured arguments can carry credentials.
    const executable = path.basename(agent.agentArgv?.[0] ?? agent.agentCommand.split(/\s+/)[0]);
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `ACP agent ${executable} did not complete ACP initialization within ${timeoutMs}ms. Check that the configured command starts an ACP server.`,
      { cause: error },
    );
  }
}

type CreatedRuntimeSession = {
  sessionId: string;
  agentSessionId: string | undefined;
  sessionResult:
    | Awaited<ReturnType<AcpClient["createSession"]>>
    | Awaited<ReturnType<AcpClient["loadSession"]>>;
};

type RuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  resumeSessionId?: string;
  sessionOptions?: SessionAgentOptions;
};

type ResolvedRuntimeAgent = {
  cwd: string;
  agentCommand: string;
  agentArgv?: string[];
};

type ExistingRuntimeSession = {
  record: SessionRecord;
  owner?: RuntimeSessionOwner;
};

type RuntimeTurnTaskState = {
  pendingCancel: boolean;
  turnActive: boolean;
  activeController: ActiveSessionController | null;
};

type RuntimeSessionTask = {
  completion: Promise<void>;
  cancel?: () => Promise<boolean>;
};

type RuntimeTurnTask = {
  input: AcpRuntimeTurnInput & { sessionMode: "persistent" | "oneshot" };
  promptInput: PromptInput | string;
  queue: AsyncEventQueue;
  promptStarted: Deferred<void>;
  sessionReady: Deferred<void>;
  state: RuntimeTurnTaskState;
  settleResult: (next: AcpRuntimeTurnResult) => void;
  abortHandler: () => void;
};

type RunningRuntimeTurn = {
  record: SessionRecord;
  conversation: ReturnType<typeof cloneSessionConversation>;
  acpxState: ReturnType<typeof cloneSessionAcpxState>;
  client: AcpClient;
  owner: RuntimeSessionOwner;
  connected: boolean;
  promptMessageId: string | undefined;
  activeSessionId: string;
};

type RuntimeSessionProjection = {
  record: SessionRecord;
  conversation: ReturnType<typeof cloneSessionConversation>;
};

type RuntimeControlSession = {
  record: SessionRecord;
  checkpoint: LiveSessionCheckpoint;
};

type RuntimeSessionOwner = {
  client: AcpClient;
  checkpoint: LiveSessionCheckpoint;
  retirement?: Promise<void>;
  sessionKey: string;
  mode: "persistent" | "oneshot";
  recordId?: string;
  projection?: RuntimeSessionProjection;
  activeTurn?: {
    task: RuntimeTurnTask;
    turn: RunningRuntimeTurn;
  };
  bufferSessionUpdates: boolean;
  pendingSessionUpdates: SessionNotification[];
};

type PreparedRuntimeTurnState = {
  record: SessionRecord;
  retainedOwner?: RuntimeSessionOwner;
  conversation: ReturnType<typeof cloneSessionConversation>;
  acpxState: ReturnType<typeof cloneSessionAcpxState>;
  promptMessageId: string | undefined;
};

async function createOrLoadRuntimeSession(
  client: AcpClient,
  resumeSessionId: string | undefined,
  cwd: string,
): Promise<CreatedRuntimeSession> {
  if (resumeSessionId) {
    if (client.supportsResumeSession()) {
      const resumed = await client.resumeSession(resumeSessionId, cwd);
      return {
        sessionId: resumeSessionId,
        agentSessionId: resumed.agentSessionId,
        sessionResult: resumed,
      };
    }
    if (!client.supportsLoadSession()) {
      throw new Error(
        `Agent does not support session/resume or session/load; cannot resume session ${resumeSessionId}`,
      );
    }
    const loaded = await client.loadSession(resumeSessionId, cwd);
    return {
      sessionId: resumeSessionId,
      agentSessionId: loaded.agentSessionId,
      sessionResult: loaded,
    };
  }

  const created = await client.createSession(cwd);
  return {
    sessionId: created.sessionId,
    agentSessionId: created.agentSessionId,
    sessionResult: created,
  };
}

export class AcpRuntimeManager {
  private readonly activeControllers = new Map<string, ActiveSessionController>();
  private readonly controlSessionRecords = new Map<string, RuntimeControlSession>();
  private readonly retainedSessionOwners = new Map<string, RuntimeSessionOwner>();
  private readonly retiringSessionOwners = new Set<RuntimeSessionOwner>();
  private readonly pendingOneShotRecordIds = new Map<string, string>();
  private readonly ensureSessionLocks = new Map<string, Promise<void>>();
  private readonly runtimeOperationLocks = new Map<string, Promise<void>>();
  private readonly sessionTasks = new Map<string, Set<RuntimeSessionTask>>();
  private readonly closingActiveRecords = new Set<string>();
  private readonly liveClients = new Set<AcpClient>();
  private readonly pendingTasks = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownTask?: Promise<void>;

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly deps: AcpRuntimeManagerDeps = {},
  ) {}

  private createClient(options: ConstructorParameters<typeof AcpClient>[0]): AcpClient {
    this.assertOpen();
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      ...options,
      agentProcessEnv: this.options.agentProcessEnv,
      processLifecycle: {
        ...options.processLifecycle,
        onBeforeSpawn: async (launch) => {
          this.assertOpen();
          await options.processLifecycle?.onBeforeSpawn?.(launch);
          this.assertOpen();
        },
        onSpawned: async (process) => {
          this.assertOpen();
          await options.processLifecycle?.onSpawned?.(process);
          this.assertOpen();
        },
      },
    };
    const client = this.deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
    this.liveClients.add(client);
    return client;
  }

  async probe(): Promise<RuntimeHealthReport> {
    let client: AcpClient | undefined;
    try {
      return await probeRuntime(this.options, {
        clientFactory: (options) => (client = this.createClient(options)),
      });
    } finally {
      if (client) {
        this.liveClients.delete(client);
      }
    }
  }

  private assertOpen(): void {
    if (this.shuttingDown) {
      throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "ACP runtime is shut down.");
    }
  }

  shutdown(): Promise<void> {
    if (!this.shutdownTask) {
      this.shuttingDown = true;
      this.shutdownTask = this.shutdownOwnedClients();
    }
    return this.shutdownTask;
  }

  private async shutdownOwnedClients(): Promise<void> {
    const closed = await Promise.allSettled(
      [...this.liveClients].map(async (client) => {
        void client.requestCancelActivePrompt().catch(() => {});
        await this.closeClient(client);
      }),
    );
    await Promise.allSettled([
      ...this.ensureSessionLocks.values(),
      ...this.runtimeOperationLocks.values(),
      ...this.pendingTasks,
    ]);
    await Promise.all(
      [...this.retainedSessionOwners.values()].map(async (owner) => {
        this.removeRetainedSessionOwner(owner);
        await this.stopSessionOwner(owner);
      }),
    );
    const errors: unknown[] = [];
    for (const result of closed) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "ACP runtime shutdown failed.");
    }
    this.retiringSessionOwners.clear();
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.pendingTasks.add(task);
    const remove = () => {
      this.pendingTasks.delete(task);
    };
    void task.then(remove, remove);
    return task;
  }

  private queueSessionTask<T>(
    recordId: string,
    run: () => Promise<T>,
    cancel?: () => Promise<boolean>,
  ): Promise<T> {
    const tasks = this.sessionTasks.get(recordId) ?? new Set<RuntimeSessionTask>();
    this.sessionTasks.set(recordId, tasks);
    const previous = [...tasks].at(-1)?.completion;
    const result = (async () => {
      await previous?.catch(() => {});
      return await run();
    })();
    const task = { completion: result.then(() => {}), cancel };
    void task.completion.catch(() => {});
    tasks.add(task);
    const remove = () => {
      tasks.delete(task);
      if (tasks.size === 0) {
        this.sessionTasks.delete(recordId);
      }
    };
    void result.then(remove, remove);
    return this.trackTask(result);
  }

  private async cancelSessionTasks(recordId: string): Promise<RuntimeSessionTask[]> {
    const tasks = [...(this.sessionTasks.get(recordId) ?? [])];
    await Promise.all(tasks.flatMap((task) => (task.cancel ? [task.cancel()] : [])));
    return tasks;
  }

  private async closeClient(client: AcpClient): Promise<void> {
    await client.close();
    this.liveClients.delete(client);
  }

  private createSessionOwner(input: {
    client: AcpClient;
    sessionKey: string;
    mode: "persistent" | "oneshot";
  }): RuntimeSessionOwner {
    const owner: RuntimeSessionOwner = {
      ...input,
      checkpoint: new LiveSessionCheckpoint({ save: async () => this.saveSessionOwner(owner) }),
      bufferSessionUpdates: false,
      pendingSessionUpdates: [],
    };
    input.client.setEventHandlers({
      onSessionUpdate: (notification) => this.routeOwnedSessionUpdate(owner, notification),
      onClientOperation: (operation) => this.routeOwnedClientOperation(owner, operation),
    });
    return owner;
  }

  private async saveSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    // Initialization owns publication until the record has been admitted.
    if (!owner.recordId) {
      return;
    }
    const active = owner.activeTurn?.turn;
    const target = active ?? owner.projection;
    if (!target) {
      return;
    }
    const { record, conversation } = target;
    if (active?.connected) {
      record.acpx = active.acpxState;
    }
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
    await this.refreshClosedState(record);
    await this.options.sessionStore.save(record);
  }

  private routeOwnedSessionUpdate(
    owner: RuntimeSessionOwner,
    notification: SessionNotification,
  ): void {
    const active = owner.activeTurn;
    if (active) {
      const { task, turn } = active;
      if (turn.connected) {
        turn.acpxState = recordSessionUpdate(turn.conversation, turn.acpxState, notification);
        owner.checkpoint.request();
      } else {
        // Reconnect setters and their notifications share the record so an older
        // notification cannot overwrite a later acknowledgement after replay.
        turn.record.acpx = recordSessionUpdate(turn.conversation, turn.record.acpx, notification);
      }
      trimConversationForRuntime(turn.conversation);
      this.emitRuntimeTurnEvent(task, {
        jsonrpc: "2.0",
        method: "session/update",
        params: notification,
      });
      return;
    }

    if (owner.bufferSessionUpdates) {
      owner.pendingSessionUpdates.push(notification);
      return;
    }

    const projection = owner.projection;
    if (!projection) {
      owner.pendingSessionUpdates.push(notification);
      return;
    }
    projection.record.acpx = recordSessionUpdate(
      projection.conversation,
      projection.record.acpx,
      notification,
    );
    trimConversationForRuntime(projection.conversation);
    owner.checkpoint.request();
  }

  private routeOwnedClientOperation(owner: RuntimeSessionOwner, operation: ClientOperation): void {
    const active = owner.activeTurn;
    if (!active) {
      return;
    }
    const { task, turn } = active;
    if (turn.connected) {
      turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
      owner.checkpoint.request();
    } else {
      turn.record.acpx = recordClientOperation(turn.conversation, turn.record.acpx, operation);
    }
    trimConversationForRuntime(turn.conversation);
    this.emitRuntimeTurnEvent(task, {
      type: "client_operation",
      ...operation,
    });
  }

  private attachIdleProjection(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
    conversation = cloneSessionConversation(record),
    acpxState = record.acpx,
  ): void {
    record.acpx = acpxState;
    owner.projection = { record, conversation };
    owner.activeTurn = undefined;
    this.drainPendingSessionUpdates(owner);
  }

  private drainPendingSessionUpdates(owner: RuntimeSessionOwner): void {
    for (const notification of owner.pendingSessionUpdates.splice(0)) {
      this.routeOwnedSessionUpdate(owner, notification);
    }
  }

  private async flushSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    await owner.client.waitForSessionUpdatesIdle?.().catch(() => {});
    await owner.checkpoint.flush();
  }

  private removeRetainedSessionOwner(owner: RuntimeSessionOwner): void {
    if (owner.recordId && this.retainedSessionOwners.get(owner.recordId) === owner) {
      this.retainedSessionOwners.delete(owner.recordId);
    }
    if (
      owner.mode === "oneshot" &&
      owner.recordId &&
      this.pendingOneShotRecordIds.get(owner.sessionKey) === owner.recordId
    ) {
      this.pendingOneShotRecordIds.delete(owner.sessionKey);
    }
  }

  private async readRetainedSessionOwner(
    record: SessionRecord,
    options: { consume: boolean },
  ): Promise<RuntimeSessionOwner | undefined> {
    const owner = this.retainedSessionOwners.get(record.acpxRecordId);
    if (!owner) {
      return undefined;
    }
    await this.flushSessionOwner(owner);
    const projectedRecord = owner.projection?.record;
    if (projectedRecord && projectedRecord !== record) {
      Object.assign(record, structuredClone(projectedRecord));
    }
    if (!owner.client.hasReusableSession(record.acpSessionId)) {
      this.removeRetainedSessionOwner(owner);
      await this.stopSessionOwner(owner);
      return undefined;
    }
    if (options.consume) {
      this.removeRetainedSessionOwner(owner);
    }
    return owner;
  }

  private async closeRetainedSessionOwner(recordId: string): Promise<void> {
    const owner = this.retainedSessionOwners.get(recordId);
    if (!owner) {
      return;
    }
    this.removeRetainedSessionOwner(owner);
    await this.stopSessionOwner(owner);
  }

  private async stopSessionOwner(owner: RuntimeSessionOwner): Promise<void> {
    await this.flushSessionOwner(owner).catch(() => {});
    await this.closeClient(owner.client).catch(() => {
      this.retiringSessionOwners.add(owner);
    });
    await owner.checkpoint.flush().catch(() => {});
    try {
      owner.client.clearEventHandlers();
    } catch {}
  }

  private async retrySessionCleanup(recordId: string): Promise<void> {
    for (const owner of this.retiringSessionOwners) {
      if (owner.recordId === recordId) {
        owner.retirement ??= this.finalizeSessionConnection({ client: owner.client, owner })
          .then(() => {
            this.retiringSessionOwners.delete(owner);
          })
          .finally(() => {
            owner.retirement = undefined;
          });
        await owner.retirement;
      }
    }
  }

  private async refreshClosedState(record: SessionRecord): Promise<boolean> {
    if (!this.closingActiveRecords.has(record.acpxRecordId)) {
      return record.closed === true;
    }
    const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => undefined);
    record.closed = true;
    record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
    if (latest?.acpx?.reset_on_next_ensure === true) {
      // Close owns its markers; the current owner owns accepted state and updates.
      record.acpx = {
        ...record.acpx,
        reset_on_next_ensure: true,
      };
    }
    return true;
  }

  private async retainPersistentSessionOwnerAfterTurn(input: {
    record: SessionRecord;
    owner: RuntimeSessionOwner;
  }): Promise<boolean> {
    const { record, owner } = input;
    if (!this.canRetainPersistentSessionOwner(owner, record)) {
      return false;
    }
    const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
    this.retainedSessionOwners.set(record.acpxRecordId, owner);
    if (previousOwner && previousOwner !== owner) {
      this.removeRetainedSessionOwner(previousOwner);
      await this.stopSessionOwner(previousOwner);
    }
    return true;
  }

  private canRetainPersistentSessionOwner(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
  ): boolean {
    return (
      !this.shuttingDown &&
      owner.mode === "persistent" &&
      !record.closed &&
      !(owner.client.hasUnresolvedPrompt?.() ?? false) &&
      owner.client.hasReusableSession(record.acpSessionId)
    );
  }

  private resolveMcpServers(session: AcpRuntimeSessionContext) {
    const servers = this.options.mcpServers;
    const { sessionKey, cwd, agentCommand, agentArgv } = session;
    return [
      ...(typeof servers === "function"
        ? servers({
            sessionKey,
            cwd,
            agentCommand,
            agentArgv: agentArgv ? [...agentArgv] : undefined,
          })
        : (servers ?? [])),
    ];
  }

  private resolveSessionPermissions(session: AcpRuntimeSessionContext) {
    const { sessionKey, cwd, agentCommand, agentArgv } = session;
    const {
      permissionMode = this.options.permissionMode,
      nonInteractivePermissions = this.options.nonInteractivePermissions,
      permissionPolicy = this.options.permissionPolicy,
      onPermissionRequest = this.options.onPermissionRequest,
    } = this.options.sessionPermissions?.({
      sessionKey,
      cwd,
      agentCommand,
      agentArgv: agentArgv ? [...agentArgv] : undefined,
    }) ?? {};
    return { permissionMode, nonInteractivePermissions, permissionPolicy, onPermissionRequest };
  }

  private resolveClientCapabilities() {
    return {
      fs: this.options.fs,
      terminal: this.options.terminal,
    };
  }

  private async withRuntimeControlSession<T>(
    record: SessionRecord,
    sessionMode: "persistent" | "oneshot",
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
    replacingConfigOption?: ConnectAndLoadSessionOptions["replacingConfigOption"],
    authority?: AcpControlAuthority,
  ): Promise<T> {
    await this.retrySessionCleanup(record.acpxRecordId);
    assertControlAuthority(authority);
    const owner = await this.readRetainedSessionOwner(record, { consume: false });
    assertControlAuthority(authority);
    if (owner) {
      const ownedRecord = owner.projection?.record ?? record;
      try {
        const value = await run({
          client: owner.client,
          sessionId: ownedRecord.acpSessionId,
          record: ownedRecord,
        });
        this.refreshOwnedRecordLifecycle(owner, ownedRecord);
        await owner.checkpoint.checkpoint();
        return value;
      } finally {
        await this.flushSessionOwner(owner);
      }
    }

    let controlClient: AcpClient | undefined;
    let controlledRecord = record;
    // Callback-driven ensure can reopen this record before the control replies.
    // Serialize that save with the accepted response and cleanup.
    const checkpoint = new LiveSessionCheckpoint({
      save: async () => this.options.sessionStore.save(controlledRecord),
    });
    try {
      const result = await settleAttempt(async () =>
        withConnectedSession({
          sessionRecordId: record.acpxRecordId,
          loadRecord: async (sessionRecordId) => {
            controlledRecord = await this.requireRecord(sessionRecordId);
            this.controlSessionRecords.set(sessionRecordId, {
              record: controlledRecord,
              checkpoint,
            });
            return controlledRecord;
          },
          saveRecord: async () => checkpoint.checkpoint(),
          createClient: (options) =>
            (controlClient = this.createClient({
              ...options,
              processLifecycle: this.options.processLifecycle,
              processLaunchScope: {
                kind: "runtime-session",
                sessionKey: record.name ?? record.acpxRecordId,
              },
            })),
          mcpServers: this.resolveMcpServers({
            ...record,
            sessionKey: record.name ?? record.acpxRecordId,
          }),
          ...this.resolveSessionPermissions({
            ...record,
            sessionKey: record.name ?? record.acpxRecordId,
          }),
          ...this.resolveClientCapabilities(),
          elicitationModes: this.options.elicitationModes,
          verbose: this.options.verbose,
          timeoutMs: this.options.timeoutMs,
          resumePolicy: resumePolicyForSessionMode(sessionMode),
          replacingConfigOption,
          authority,
          run,
        }),
      );
      this.controlSessionRecords.delete(record.acpxRecordId);
      const flushed = await settleAttempt(async () => checkpoint.flush());
      if (!result.ok) {
        throw result.error;
      }
      if (!flushed.ok) {
        throw flushed.error;
      }
      return result.value.value;
    } finally {
      this.controlSessionRecords.delete(record.acpxRecordId);
      if (controlClient) {
        this.liveClients.delete(controlClient);
      }
    }
  }

  private refreshOwnedRecordLifecycle(owner: RuntimeSessionOwner, record: SessionRecord): void {
    record.lastUsedAt = isoNow();
    record.closed = false;
    record.closedAt = undefined;
    record.protocolVersion = owner.client.initializeResult?.protocolVersion;
    record.agentCapabilities = owner.client.initializeResult?.agentCapabilities;
    applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
  }

  async ensureSession(input: RuntimeEnsureInput): Promise<SessionRecord> {
    return await this.withEnsureSessionLock(input, async () =>
      this.ensureSessionWithOwnership(input),
    );
  }

  private async withEnsureSessionLock<T>(
    input: RuntimeEnsureInput,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.mode}\0${input.sessionKey}`;
    return await this.withManagerLock(this.ensureSessionLocks, key, run);
  }

  private async withManagerLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    run: () => Promise<T>,
    authority?: AcpControlAuthority,
  ): Promise<T> {
    this.assertOpen();
    assertControlAuthority(authority);
    return await this.serializeManagerOperation(locks, key, async () => {
      this.assertOpen();
      assertControlAuthority(authority);
      return await run();
    });
  }

  private async serializeManagerOperation<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    locks.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    }
  }

  private async ensureSessionWithOwnership(input: RuntimeEnsureInput): Promise<SessionRecord> {
    const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
    const { agentCommand, agentArgv } = normalizeAgentCommandInput(
      this.options.agentRegistry.resolve(input.agent),
    );
    const agent = { cwd, agentCommand, agentArgv };
    if (input.mode !== "persistent") {
      return await this.acquireRuntimeSession(input, agent);
    }
    const compatible = await this.reuseCompatiblePersistentSession(input, agent);
    if (compatible) {
      return compatible;
    }
    this.assertRuntimeSessionIdle(input.sessionKey);
    return await this.withManagerLock(this.runtimeOperationLocks, input.sessionKey, async () =>
      this.acquireRuntimeSession(input, agent),
    );
  }

  private async reuseCompatiblePersistentSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord | undefined> {
    const controlled = this.controlSessionRecords.get(input.sessionKey);
    const record = controlled ? controlled.record : await this.findSession(input.sessionKey);
    if (
      !record ||
      this.closingActiveRecords.has(input.sessionKey) ||
      !shouldReuseExistingRecord(record, { ...agent, resumeSessionId: input.resumeSessionId })
    ) {
      return undefined;
    }
    if (!record.closed) {
      return record;
    }
    if (!controlled || this.sessionTasks.has(input.sessionKey)) {
      return undefined;
    }
    // Native control callbacks may ensure this identity before replying. Reuse
    // the control owner's record rather than waiting for that same reply.
    return await this.reuseRuntimeSession({ record }, controlled.checkpoint);
  }

  private async acquireRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord> {
    const existing = await this.loadExistingRuntimeSession(input);
    if (existing && this.canReuseRuntimeSession(input, agent, existing)) {
      return await this.reuseRuntimeSession(existing);
    }
    await this.closeConflictingPersistentSession(input, existing?.owner);
    return await this.createOwnedRuntimeSession(input, agent);
  }

  private async loadExistingRuntimeSession(
    input: RuntimeEnsureInput,
  ): Promise<ExistingRuntimeSession | undefined> {
    const existingRecordId =
      input.mode === "persistent"
        ? input.sessionKey
        : this.pendingOneShotRecordIds.get(input.sessionKey);
    if (!existingRecordId) {
      return undefined;
    }
    await this.retrySessionCleanup(existingRecordId);
    let record = await this.findSession(existingRecordId);
    if (!record) {
      return undefined;
    }
    const owner = this.retainedSessionOwners.get(record.acpxRecordId);
    if (owner) {
      await this.flushSessionOwner(owner);
      record = owner.projection?.record ?? record;
    }
    return { record, owner };
  }

  async findSession(sessionKey: string): Promise<SessionRecord | undefined> {
    return await this.options.sessionStore.load(sessionKey);
  }

  private canReuseRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
    existing: ExistingRuntimeSession,
  ): boolean {
    if (
      !shouldReuseExistingRecord(existing.record, {
        cwd: agent.cwd,
        agentCommand: agent.agentCommand,
        agentArgv: agent.agentArgv,
        resumeSessionId: input.resumeSessionId,
      })
    ) {
      return false;
    }
    if (input.mode === "persistent") {
      return true;
    }
    return Boolean(
      existing.owner &&
      !existing.record.closed &&
      this.pendingOneShotRecordIds.get(input.sessionKey) === existing.record.acpxRecordId &&
      this.retainedSessionOwners.get(existing.record.acpxRecordId) === existing.owner &&
      isDeepStrictEqual(sessionOptionsFromRecord(existing.record), input.sessionOptions),
    );
  }

  private assertRuntimeSessionIdle(recordId: string): void {
    if (this.sessionTasks.has(recordId) || this.runtimeOperationLocks.has(recordId)) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Cannot ensure session ${recordId} with incompatible or closing state while its work is unfinished. Wait for existing work to finish or use a different session key.`,
      );
    }
  }

  private async reuseRuntimeSession(
    { record, owner }: ExistingRuntimeSession,
    checkpoint = owner?.checkpoint,
  ): Promise<SessionRecord> {
    // sessionOptions on a reused persistent record are intentionally ignored:
    // system prompts are fixed at newSession time. Pending one-shot records are
    // reused only when their options still match.
    if (!record.closed && !this.closingActiveRecords.has(record.acpxRecordId)) {
      return record;
    }
    record.closed = false;
    record.closedAt = undefined;
    this.closingActiveRecords.delete(record.acpxRecordId);
    if (checkpoint) {
      await checkpoint.checkpoint();
    } else {
      await this.options.sessionStore.save(record);
    }
    return record;
  }

  private async closeConflictingPersistentSession(
    input: RuntimeEnsureInput,
    owner: RuntimeSessionOwner | undefined,
  ): Promise<void> {
    if (input.mode === "persistent" && owner?.recordId) {
      this.removeRetainedSessionOwner(owner);
      this.retiringSessionOwners.add(owner);
      await this.retrySessionCleanup(owner.recordId);
    }
  }

  private async createOwnedRuntimeSession(
    input: RuntimeEnsureInput,
    agent: ResolvedRuntimeAgent,
  ): Promise<SessionRecord> {
    const { cwd, agentCommand, agentArgv } = agent;
    const client = this.createClient({
      agentCommand,
      agentArgv,
      cwd,
      mcpServers: this.resolveMcpServers({ ...agent, sessionKey: input.sessionKey }),
      ...this.resolveSessionPermissions({ ...agent, sessionKey: input.sessionKey }),
      ...this.resolveClientCapabilities(),
      elicitationModes: this.options.elicitationModes,
      processLifecycle: this.options.processLifecycle,
      processLaunchScope: { kind: "runtime-session", sessionKey: input.sessionKey },
      verbose: this.options.verbose,
      sessionOptions: input.sessionOptions,
    });
    const owner = this.createSessionOwner({
      client,
      sessionKey: input.sessionKey,
      mode: input.mode,
    });
    let retained = false;

    try {
      await startRuntimeClient(client, agent, this.options.timeoutMs);
      this.assertOpen();
      const session = await createOrLoadRuntimeSession(client, input.resumeSessionId, cwd);
      const record = await this.prepareInitialRuntimeRecord({
        input,
        client,
        owner,
        agentCommand,
        agentArgv,
        cwd,
        session,
      });
      await this.retainInitializedSessionOwner(owner, record);
      retained = true;
      return record;
    } finally {
      if (!retained) {
        owner.recordId = undefined;
        client.clearEventHandlers();
        await this.closeClient(client);
      }
    }
  }

  private async prepareInitialRuntimeRecord(params: {
    input: {
      sessionKey: string;
      mode: "persistent" | "oneshot";
      sessionOptions?: SessionAgentOptions;
    };
    client: AcpClient;
    owner: RuntimeSessionOwner;
    agentCommand: string;
    agentArgv?: string[];
    cwd: string;
    session: CreatedRuntimeSession;
  }): Promise<SessionRecord> {
    const { input, client, owner, agentCommand, agentArgv, cwd, session } = params;
    const record = createInitialSessionRecord({
      recordId: createRecordId(input.sessionKey, input.mode),
      name: input.sessionKey,
      sessionId: session.sessionId,
      agentCommand,
      agentArgv,
      cwd,
      agentSessionId: session.agentSessionId,
    });
    this.closingActiveRecords.delete(record.acpxRecordId);
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
    // Fold pre-response notifications first; later controls and their updates
    // then share this record and retain wire order through acknowledgement.
    this.attachIdleProjection(owner, record);
    applyConfigOptionsToRecord(record, session.sessionResult);
    const modelApplication = await applyRequestedModelIfAdvertised({
      client,
      sessionId: session.sessionId,
      requestedModel: input.sessionOptions?.model,
      models: session.sessionResult.models,
      agentCommand,
      timeoutMs: this.options.timeoutMs,
    });
    applyInitialModelSelection(
      record,
      session.sessionResult.models,
      input.sessionOptions?.model,
      modelApplication,
    );
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    persistSessionOptions(record, input.sessionOptions);
    return record;
  }

  private async retainInitializedSessionOwner(
    owner: RuntimeSessionOwner,
    record: SessionRecord,
  ): Promise<void> {
    owner.recordId = record.acpxRecordId;
    // The checkpoint loop also persists notifications arriving during the
    // initial async save before this owner becomes available for reuse.
    await owner.checkpoint.checkpoint();
    this.assertOpen();
    const previousOwner = this.retainedSessionOwners.get(record.acpxRecordId);
    this.retainedSessionOwners.set(record.acpxRecordId, owner);
    if (owner.mode === "oneshot") {
      this.pendingOneShotRecordIds.set(owner.sessionKey, record.acpxRecordId);
    }
    if (previousOwner && previousOwner !== owner) {
      this.removeRetainedSessionOwner(previousOwner);
      await this.stopSessionOwner(previousOwner);
    }
  }

  startTurn(input: RuntimeTurnTask["input"]): AcpRuntimeTurn {
    this.assertOpen();
    let promptInput: PromptInput | string;
    try {
      promptInput = toPromptInput(input.text, input.attachments);
    } catch (error) {
      void this.trackTask(this.closeRetainedOneShotHandle(input.handle).catch(() => {}));
      throw error;
    }
    const queue = new AsyncEventQueue();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const promptStarted = createDeferred<void>();
    void promptStarted.promise.catch(() => {});
    const sessionReady = createDeferred<void>();
    void sessionReady.promise.catch(() => {});
    let resultSettled = false;
    const state: RuntimeTurnTaskState = {
      pendingCancel: false,
      turnActive: true,
      activeController: null,
    };
    let streamClosed = false;

    const settleResult = (next: AcpRuntimeTurnResult): void => {
      if (resultSettled) {
        return;
      }
      resultSettled = true;
      result.resolve(next);
    };

    const closeStream = (): void => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      queue.clear();
      queue.close();
    };

    const requestCancel = async (): Promise<boolean> => {
      if (state.activeController) {
        return await state.activeController.requestCancelActivePrompt();
      }
      if (!state.turnActive) {
        return false;
      }
      state.pendingCancel = true;
      return true;
    };

    const abortHandler = () => {
      void requestCancel().catch(() => {});
    };
    if (input.signal && !input.signal.aborted) {
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }

    void this.queueSessionTask(
      input.handle.acpxRecordId ?? input.handle.sessionKey,
      async () =>
        this.runRuntimeTurnTask({
          input,
          promptInput,
          queue,
          promptStarted,
          sessionReady,
          state,
          settleResult,
          abortHandler,
        }),
      requestCancel,
    );

    return {
      requestId: input.requestId,
      promptStarted: promptStarted.promise,
      events: queue.iterate(),
      result: result.promise,
      cancel: async () => {
        await requestCancel();
      },
      closeStream: async () => {
        closeStream();
      },
    };
  }

  private async closeRetainedOneShotHandle(handle: AcpRuntimeHandle): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.serializeManagerOperation(this.runtimeOperationLocks, recordId, async () => {
      const owner = this.retainedSessionOwners.get(recordId);
      if (owner?.mode === "oneshot") {
        await this.closeRetainedSessionOwner(recordId);
      }
    });
  }

  private async runRuntimeTurnTask(task: RuntimeTurnTask): Promise<void> {
    let turn: RunningRuntimeTurn | undefined;
    let terminalResult: AcpRuntimeTurnResult;
    try {
      if (this.cancelRuntimeTurnBeforePrompt(task)) {
        await this.closeRetainedOneShotHandle(task.input.handle);
        terminalResult = {
          status: "cancelled",
          stopReason: "cancelled",
        };
      } else {
        turn = await this.prepareRuntimeTurn(task);
        const { sessionId } = await this.connectRuntimeTurn(task, turn);
        this.assertOpen();
        await this.resolveRuntimeTurnReady(task, turn);
        if (this.cancelRuntimeTurnBeforePrompt(task)) {
          terminalResult = { status: "cancelled", stopReason: "cancelled" };
        } else {
          const response = await this.runRuntimePrompt(task, turn, sessionId);
          this.updateCompletedRuntimeTurn(turn);
          terminalResult = {
            status: response.stopReason === "cancelled" ? "cancelled" : "completed",
            ...(response.stopReason ? { stopReason: response.stopReason } : {}),
            ...(response._meta === undefined ? {} : { _meta: response._meta }),
          };
        }
      }
    } catch (error) {
      terminalResult = this.handleRuntimeTurnFailure(task, error);
    }
    const finalization = await settleAttempt(async () =>
      this.serializeManagerOperation(
        this.runtimeOperationLocks,
        task.input.handle.acpxRecordId ?? task.input.handle.sessionKey,
        async () => this.finalizeRuntimeTurn(task, turn),
      ),
    );
    if (!finalization.ok) {
      task.settleResult(this.failRuntimeTurn(task, finalization.error));
      throw finalization.error;
    }
    task.settleResult(terminalResult);
  }

  private async runRuntimePrompt(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
    sessionId: string,
  ): ReturnType<typeof runPromptTurn> {
    return await runPromptTurn({
      client: turn.client,
      sessionId,
      prompt: task.promptInput,
      timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
      conversation: turn.conversation,
      promptMessageId: turn.promptMessageId,
      onPromptRequestWritten: () => task.promptStarted.resolve(),
      onElicitation: task.input.onElicitation,
      onPermissionRequest: task.input.onPermissionRequest,
      authority: task.input,
    });
  }

  private async prepareRuntimeTurn(task: RuntimeTurnTask): Promise<RunningRuntimeTurn> {
    const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
    return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
      await this.retrySessionCleanup(recordId);
      return await this.prepareRuntimeTurnWithOwnership(task);
    });
  }

  private async prepareRuntimeTurnWithOwnership(
    task: RuntimeTurnTask,
  ): Promise<RunningRuntimeTurn> {
    const prepared = await this.prepareRuntimeTurnState(task);
    const { record, retainedOwner, conversation, acpxState, promptMessageId } = prepared;
    try {
      const client = retainedOwner?.client ?? this.createTurnClient(record);
      const owner = this.resolveRuntimeTurnOwner(task, record, client, retainedOwner);
      const turn = this.createRunningRuntimeTurn({
        record,
        conversation,
        acpxState,
        client,
        owner,
        connected: retainedOwner !== undefined,
        promptMessageId,
      });
      this.activateRuntimeTurn(task, turn);
      return turn;
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private async prepareRuntimeTurnState(task: RuntimeTurnTask): Promise<PreparedRuntimeTurnState> {
    const acquired = await this.acquireRuntimeTurnState(task);
    const { record, retainedOwner } = acquired;
    const conversation = cloneSessionConversation(record);
    const acpxState = cloneSessionAcpxState(record.acpx);
    try {
      const promptStartedAt = isoNow();
      const promptMessageId = recordPromptSubmission(
        conversation,
        task.promptInput,
        promptStartedAt,
      );
      trimConversationForRuntime(conversation);
      record.lastPromptAt = promptStartedAt;
      record.lastUsedAt = promptStartedAt;
      record.acpx = acpxState;
      applyConversation(record, conversation);
      await this.options.sessionStore.save(record);
      return { record, retainedOwner, conversation, acpxState, promptMessageId };
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private async acquireRuntimeTurnState(task: RuntimeTurnTask): Promise<{
    record: SessionRecord;
    retainedOwner?: RuntimeSessionOwner;
  }> {
    const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
    let record = await this.requireRecord(recordId);
    const retainedOwner = await this.readRetainedSessionOwner(record, { consume: false });
    if (!retainedOwner) {
      return { record };
    }
    retainedOwner.bufferSessionUpdates = true;
    try {
      await retainedOwner.checkpoint.flush();
      const projection = retainedOwner.projection;
      if (projection) {
        record = structuredClone(projection.record);
      }
      return { record, retainedOwner };
    } catch (error) {
      this.restoreBufferedSessionOwner(retainedOwner);
      throw error;
    }
  }

  private restoreBufferedSessionOwner(owner: RuntimeSessionOwner | undefined): void {
    if (!owner) {
      return;
    }
    owner.bufferSessionUpdates = false;
    this.drainPendingSessionUpdates(owner);
  }

  private resolveRuntimeTurnOwner(
    task: RuntimeTurnTask,
    record: SessionRecord,
    client: AcpClient,
    retainedOwner: RuntimeSessionOwner | undefined,
  ): RuntimeSessionOwner {
    return (
      retainedOwner ??
      this.createSessionOwner({
        client,
        sessionKey: record.name ?? task.input.handle.sessionKey,
        mode: task.input.sessionMode,
      })
    );
  }

  private createRunningRuntimeTurn(input: {
    record: SessionRecord;
    conversation: ReturnType<typeof cloneSessionConversation>;
    acpxState: ReturnType<typeof cloneSessionAcpxState>;
    client: AcpClient;
    owner: RuntimeSessionOwner;
    connected: boolean;
    promptMessageId: string | undefined;
  }): RunningRuntimeTurn {
    const { record, conversation, acpxState, client, owner, connected, promptMessageId } = input;
    const turn: RunningRuntimeTurn = {
      record,
      conversation,
      acpxState,
      client,
      owner,
      connected,
      promptMessageId,
      activeSessionId: record.acpSessionId,
    };
    return turn;
  }

  private activateRuntimeTurn(task: RuntimeTurnTask, turn: RunningRuntimeTurn): void {
    const { owner, record } = turn;
    this.removeRetainedSessionOwner(owner);
    owner.recordId = record.acpxRecordId;
    task.state.activeController = this.buildRuntimeTurnController(task, turn);
    this.activeControllers.set(record.acpxRecordId, task.state.activeController);
    owner.projection = undefined;
    owner.activeTurn = { task, turn };
    owner.bufferSessionUpdates = false;
    this.drainPendingSessionUpdates(owner);
  }

  private createTurnClient(record: SessionRecord): AcpClient {
    return this.createClient({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: record.cwd,
      mcpServers: this.resolveMcpServers({
        ...record,
        sessionKey: record.name ?? record.acpxRecordId,
      }),
      ...this.resolveSessionPermissions({
        ...record,
        sessionKey: record.name ?? record.acpxRecordId,
      }),
      ...this.resolveClientCapabilities(),
      elicitationModes: this.options.elicitationModes,
      processLifecycle: this.options.processLifecycle,
      processLaunchScope: {
        kind: "runtime-session",
        sessionKey: record.name ?? record.acpxRecordId,
      },
      verbose: this.options.verbose,
      sessionOptions: sessionOptionsFromRecord(record),
    });
  }

  private buildRuntimeTurnController(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): ActiveSessionController {
    return {
      hasActivePrompt: () => turn.client.hasActivePrompt(),
      requestCancelActivePrompt: async () => await this.requestRuntimeTurnCancel(task, turn),
      setSessionMode: async (modeId: string, authority) => {
        await this.waitForRuntimeControlSession(task, turn);
        await turn.client.setSessionMode(turn.activeSessionId, modeId, authority);
        const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
        nextState.desired_mode_id = modeId;
        turn.acpxState = nextState;
        await turn.owner.checkpoint.checkpoint();
      },
      setSessionModel: async (modelId: string, authority) => {
        await this.waitForRuntimeControlSession(task, turn);
        const models = advertisedModelState(turn.acpxState);
        const response = await turn.client.setSessionModel(
          turn.activeSessionId,
          modelId,
          models,
          authority,
        );
        turn.acpxState = applyModelSelection(turn.acpxState, modelId, response);
        await turn.owner.checkpoint.checkpoint();
        return response;
      },
      setSessionConfigOption: async (configId: string, value: string, authority) => {
        const result = await task.state.activeController!.setResolvedSessionConfigOption(
          configId,
          value,
          authority,
        );
        return result.response;
      },
      setResolvedSessionConfigOption: async (configId: string, value: string, authority) =>
        await this.setRuntimeResolvedSessionConfigOption(task, turn, configId, value, authority),
    };
  }

  private async waitForRuntimeControlSession(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<void> {
    if (turn.client.hasActivePrompt()) {
      return;
    }
    await task.sessionReady.promise;
  }

  private async requestRuntimeTurnCancel(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<boolean> {
    if (turn.client.hasActivePrompt()) {
      return await turn.client.requestCancelActivePrompt();
    }
    if (!task.state.turnActive) {
      return false;
    }
    task.state.pendingCancel = true;
    return true;
  }

  private async setRuntimeResolvedSessionConfigOption(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
    configId: string,
    value: string,
    authority?: AcpControlAuthority,
  ): Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }> {
    await this.waitForRuntimeControlSession(task, turn);
    const resolvedConfigId = resolveSupportedConfigOptionId(
      {
        ...turn.record,
        acpx: turn.acpxState ?? undefined,
      },
      configId,
    );
    // Notifications can remove the model control before the setter resolves.
    const models = advertisedModelState(turn.acpxState);
    const response = await turn.client.setSessionConfigOption(
      turn.activeSessionId,
      resolvedConfigId,
      value,
      models,
      authority,
    );
    turn.acpxState = applyConfigOptionSelection(
      turn.acpxState,
      resolvedConfigId,
      value,
      response,
      models?.configId,
    );
    await turn.owner.checkpoint.checkpoint();
    return { configId: resolvedConfigId, response };
  }

  private emitRuntimeTurnEvent(task: RuntimeTurnTask, payload: Record<string, unknown>): void {
    const parsed = parsePromptEventLine(JSON.stringify(payload));
    if (!parsed) {
      return;
    }
    task.queue.push(parsed);
  }

  private async connectRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<ConnectAndLoadSessionResult> {
    if (turn.connected) {
      return { sessionId: turn.record.acpSessionId, resumed: false, loadError: undefined };
    }
    const loaded = await this.connectRuntimeTurnClient(task, turn);
    turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
    turn.connected = true;
    return loaded;
  }

  private async connectRuntimeTurnClient(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<ConnectAndLoadSessionResult> {
    return await connectAndLoadSession({
      client: turn.client,
      record: turn.record,
      resumePolicy: resumePolicyForSessionMode(task.input.sessionMode),
      timeoutMs: this.options.timeoutMs,
      activeController: task.state.activeController!,
      onClientAvailable: () => this.publishRuntimeTurnController(task, turn),
      onConnectedRecord: (connectedRecord) => {
        connectedRecord.lastPromptAt = isoNow();
      },
      onSessionIdResolved: (sessionIdValue) => {
        turn.activeSessionId = sessionIdValue;
      },
    });
  }

  private publishRuntimeTurnController(task: RuntimeTurnTask, turn: RunningRuntimeTurn): void {
    const controller = task.state.activeController;
    if (controller) {
      this.activeControllers.set(turn.record.acpxRecordId, controller);
    }
  }

  private async resolveRuntimeTurnReady(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<void> {
    task.sessionReady.resolve();
    turn.record.lastRequestId = task.input.requestId;
    turn.record.lastPromptAt = isoNow();
    turn.record.closed = false;
    turn.record.closedAt = undefined;
    turn.record.lastUsedAt = isoNow();
    await turn.owner.checkpoint.checkpoint();
  }

  private cancelRuntimeTurnBeforePrompt(task: RuntimeTurnTask): boolean {
    if (!task.state.pendingCancel && !task.input.signal?.aborted) {
      return false;
    }
    task.state.pendingCancel = false;
    task.promptStarted.reject(new Error("ACP turn cancelled before prompt submission."));
    return true;
  }

  private updateCompletedRuntimeTurn(turn: RunningRuntimeTurn): void {
    turn.record.acpSessionId = turn.activeSessionId;
    reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
    turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
    turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
  }

  private handleRuntimeTurnFailure(task: RuntimeTurnTask, error: unknown): AcpRuntimeTurnResult {
    if (!task.input.signal?.aborted || error !== task.input.signal.reason) {
      return this.failRuntimeTurn(task, error);
    }
    task.promptStarted.reject(error);
    task.sessionReady.reject(error);
    return { status: "cancelled", stopReason: "cancelled" };
  }

  private failRuntimeTurn(task: RuntimeTurnTask, error: unknown): AcpRuntimeTurnResult {
    task.promptStarted.reject(error);
    task.sessionReady.reject(error);
    const normalized = normalizeOutputError(error, { origin: "runtime" });
    return {
      status: "failed",
      error: {
        message: normalized.message,
        ...(normalized.code ? { code: normalized.code } : {}),
        ...(normalized.detailCode ? { detailCode: normalized.detailCode } : {}),
        ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
      },
    };
  }

  private async finalizeRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn | undefined,
  ): Promise<void> {
    task.state.turnActive = false;
    const abortHandlerAttempt = await settleAttempt(() =>
      task.input.signal?.removeEventListener("abort", task.abortHandler),
    );
    const recordAttempt = await settleAttempt(async () =>
      turn ? await this.finalizeRuntimeTurnRecord(turn) : false,
    );
    let failure = firstFailedAttempt([abortHandlerAttempt, recordAttempt]);
    let pooled = recordAttempt.ok ? recordAttempt.value : false;
    if (failure) {
      this.discardRetainedRuntimeTurnOwner(turn);
      pooled = false;
    }
    const closeAttempt = await settleAttempt(async () => this.closeRuntimeTurnClient(turn, pooled));
    this.cleanupRuntimeTurn(task, turn);
    failure ??= firstFailedAttempt([closeAttempt]);
    if (failure) {
      throw failure.error;
    }
  }

  private discardRetainedRuntimeTurnOwner(turn: RunningRuntimeTurn | undefined): void {
    if (turn) {
      this.removeRetainedSessionOwner(turn.owner);
      this.attachFinalRuntimeProjection(turn);
    }
  }

  private attachFinalRuntimeProjection(turn: RunningRuntimeTurn): void {
    const current = turn.connected ? turn.acpxState : turn.record.acpx;
    const state =
      turn.record.acpx?.reset_on_next_ensure === true
        ? { ...current, reset_on_next_ensure: true }
        : current;
    this.attachIdleProjection(turn.owner, turn.record, turn.conversation, state);
  }

  private async closeRuntimeTurnClient(
    turn: RunningRuntimeTurn | undefined,
    pooled: boolean,
  ): Promise<void> {
    if (!turn || pooled) {
      return;
    }
    const clearAttempt = await settleAttempt(() => turn.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => this.closeClient(turn.client));
    const flushAttempt = await settleAttempt(async () => this.flushSessionOwner(turn.owner));
    const failure = firstFailedAttempt([clearAttempt, closeAttempt, flushAttempt]);
    if (failure) {
      this.retiringSessionOwners.add(turn.owner);
      throw failure.error;
    }
  }

  private cleanupRuntimeTurn(task: RuntimeTurnTask, turn: RunningRuntimeTurn | undefined): void {
    if (turn) {
      this.activeControllers.delete(turn.record.acpxRecordId);
      this.closingActiveRecords.delete(turn.record.acpxRecordId);
    }
    task.queue.close();
  }

  private async finalizeRuntimeTurnRecord(turn: RunningRuntimeTurn): Promise<boolean> {
    if (!turn.connected) {
      turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
    }
    await turn.owner.checkpoint.checkpoint();
    this.attachFinalRuntimeProjection(turn);
    // A loaded transport is not reusable until preference reconciliation succeeds.
    if (turn.record.closed || !turn.connected) {
      return false;
    }
    return await this.retainPersistentSessionOwnerAfterTurn({
      record: turn.record,
      owner: turn.owner,
    });
  }

  async *runTurn(input: RuntimeTurnTask["input"]): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    yield* turn.events;
    yield legacyTerminalEventFromTurnResult(await turn.result);
  }

  getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    this.assertOpen();
    return this.trackTask(this.readStatus(handle));
  }

  private async readStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const owner = this.retainedSessionOwners.get(recordId);
    if (owner) {
      await this.flushSessionOwner(owner);
    }
    const record = await this.requireRecord(recordId);
    return runtimeStatusFromRecord(record);
  }

  async setMode(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setModeWithOwnership(handle, mode, sessionMode, authority),
      authority,
    );
  }

  private async setModeWithOwnership(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionMode(mode, authority);
      return;
    }
    await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        await client.setSessionMode(sessionId, mode, authority);
        setDesiredModeId(connectedRecord, mode);
      },
      undefined,
      authority,
    );
  }

  async setModel(
    handle: AcpRuntimeHandle,
    model: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setModelWithOwnership(handle, model, sessionMode, authority),
      authority,
    );
  }

  private async setModelWithOwnership(
    handle: AcpRuntimeHandle,
    model: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      await controller.setSessionModel(model, authority);
      return;
    }
    await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const response = await client.setSessionModel(
          sessionId,
          model,
          advertisedModelState(connectedRecord.acpx),
          authority,
        );
        connectedRecord.acpx = applyModelSelection(connectedRecord.acpx, model, response);
      },
      { key: "model" },
      authority,
    );
  }

  async setConfigOption(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
    authority?: AcpControlAuthority,
  ): Promise<SetSessionConfigOptionResponse> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    return await this.withManagerLock(
      this.runtimeOperationLocks,
      recordId,
      async () => this.setConfigOptionWithOwnership(handle, key, value, sessionMode, authority),
      authority,
    );
  }

  private async setConfigOptionWithOwnership(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot",
    authority?: AcpControlAuthority,
  ): Promise<SetSessionConfigOptionResponse> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    assertControlAuthority(authority);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      const { response } = await controller.setResolvedSessionConfigOption(key, value, authority);
      return response;
    }

    return await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const configId = resolveSupportedConfigOptionId(connectedRecord, key);
        const models = advertisedModelState(connectedRecord.acpx);
        const response = await client.setSessionConfigOption(
          sessionId,
          configId,
          value,
          models,
          authority,
        );
        connectedRecord.acpx = applyConfigOptionSelection(
          connectedRecord.acpx,
          configId,
          value,
          response,
          models?.configId,
        );
        return response;
      },
      { key, resolve: (connectedRecord) => resolveSupportedConfigOptionId(connectedRecord, key) },
      authority,
    );
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  prepareFreshSession(handle: AcpRuntimeHandle): Promise<void> {
    this.assertOpen();
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const cancelled = this.cancelSessionTasks(recordId);
    void cancelled.catch(() => {});
    return this.queueSessionTask(recordId, async () => {
      const tasks = await cancelled;
      await Promise.all(tasks.map((task) => task.completion));
      return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () =>
        this.closeRuntimeSession(handle, "prepare-fresh"),
      );
    });
  }

  close(
    handle: AcpRuntimeHandle,
    options: { discardPersistentState?: boolean } = {},
  ): Promise<void> {
    this.assertOpen();
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    return this.trackTask(
      this.withManagerLock(this.runtimeOperationLocks, recordId, async () => {
        return await this.closeRuntimeSession(
          handle,
          options.discardPersistentState === true ? "discard" : "release",
        );
      }),
    );
  }

  private async closeRuntimeSession(
    handle: AcpRuntimeHandle,
    intent: "release" | "prepare-fresh" | "discard",
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.retrySessionCleanup(recordId);
    const record = await this.resolveRuntimeRecordForClose(recordId);
    this.markActiveRuntimeRecordClosing(record);
    if (intent !== "prepare-fresh") {
      await this.cancelSessionTasks(recordId);
    }
    await this.closeRuntimeRecordOwnership(record, intent);
    record.closed = true;
    record.closedAt = isoNow();
    await this.options.sessionStore.save(record);
  }

  private async resolveRuntimeRecordForClose(recordId: string): Promise<SessionRecord> {
    const retainedOwner = this.retainedSessionOwners.get(recordId);
    if (retainedOwner) {
      await this.flushSessionOwner(retainedOwner);
    }
    return retainedOwner?.projection?.record ?? (await this.requireRecord(recordId));
  }

  private markActiveRuntimeRecordClosing(record: SessionRecord): void {
    if (this.activeControllers.has(record.acpxRecordId)) {
      this.closingActiveRecords.add(record.acpxRecordId);
    }
  }

  private async closeRuntimeRecordOwnership(
    record: SessionRecord,
    intent: "release" | "prepare-fresh" | "discard",
  ): Promise<void> {
    if (intent === "discard") {
      await this.closeBackendSession(record);
    } else if (intent === "prepare-fresh") {
      const owner = this.retainedSessionOwners.get(record.acpxRecordId);
      if (owner) {
        this.removeRetainedSessionOwner(owner);
        this.retiringSessionOwners.add(owner);
      }
      await this.retrySessionCleanup(record.acpxRecordId);
    } else {
      await this.closeRetainedSessionOwner(record.acpxRecordId);
    }
    if (intent !== "release") {
      record.acpx = {
        ...record.acpx,
        reset_on_next_ensure: true,
      };
    }
  }

  private async closeBackendSession(record: SessionRecord): Promise<void> {
    const connection = await this.acquireBackendCloseConnection(record);

    try {
      await this.requestBackendSessionClose(record, connection);
    } catch (error) {
      this.handleBackendSessionCloseError(record, error);
    } finally {
      await this.finalizeSessionConnection(connection);
    }
  }

  private async finalizeSessionConnection(connection: {
    client: AcpClient;
    owner?: RuntimeSessionOwner;
  }): Promise<void> {
    const flushAttempt = await settleAttempt(async () => {
      if (connection.owner) {
        await this.flushSessionOwner(connection.owner);
      }
    });
    const clearAttempt = await settleAttempt(() => connection.owner?.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => this.closeClient(connection.client));
    const finalFlushAttempt = await settleAttempt(async () => connection.owner?.checkpoint.flush());
    const failure = firstFailedAttempt([
      flushAttempt,
      clearAttempt,
      closeAttempt,
      finalFlushAttempt,
    ]);
    if (failure) {
      throw failure.error;
    }
  }

  private async acquireBackendCloseConnection(record: SessionRecord): Promise<{
    client: AcpClient;
    owner?: RuntimeSessionOwner;
  }> {
    const owner = await this.readRetainedSessionOwner(record, { consume: true });
    if (owner) {
      return { client: owner.client, owner };
    }
    return {
      client: this.createTurnClient(record),
    };
  }

  private async requestBackendSessionClose(
    record: SessionRecord,
    connection: { client: AcpClient; owner?: RuntimeSessionOwner },
  ): Promise<void> {
    if (!connection.owner) {
      await withTimeout(connection.client.start(), this.options.timeoutMs);
    }
    if (!connection.client.supportsCloseSession()) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Agent does not support session/close for ${record.acpxRecordId}.`,
      );
    }
    await withTimeout(connection.client.closeSession(record.acpSessionId), this.options.timeoutMs);
  }

  private handleBackendSessionCloseError(record: SessionRecord, error: unknown): void {
    if (isAcpResourceNotFoundError(error)) {
      return;
    }
    if (isUnsupportedSessionCloseError(error)) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Agent does not support session/close for ${record.acpxRecordId}.`,
        { cause: error },
      );
    }
    throw error;
  }

  private async requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.options.sessionStore.load(sessionId);
    if (!record) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return record;
  }
}
