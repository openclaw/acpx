import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionNotification, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { normalizeAgentCommandInput } from "../../acp/client-process.js";
import { AcpClient } from "../../acp/client.js";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { extractAcpError, isAcpResourceNotFoundError } from "../../acp/error-shapes.js";
import { modelStateFromConfigOptions } from "../../acp/model-support.js";
import { withTimeout } from "../../async-control.js";
import { textPrompt, type PromptInput } from "../../prompt-content.js";
import {
  applyConfigOptionsToRecord,
  applyConfigOptionSelection,
  applyModelSelection,
} from "../../session/config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  createSessionConversation,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import {
  setCurrentModelId,
  setDesiredModeId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelIfAdvertised,
  currentModelIdFromSetModelResponse,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import type {
  ClientOperation,
  SessionRecord,
  SessionResumePolicy,
  SessionTokenUsage,
} from "../../types.js";
import type {
  AcpElicitationHandler,
  AcpRuntimeAvailableCommand,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimePromptMode,
  AcpRuntimeSessionModels,
  AcpRuntimeSessionUsage,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
  AcpRuntimeUsageBreakdown,
} from "../public/contract.js";
import { AcpRuntimeError } from "../public/errors.js";
import { parsePromptEventLine } from "../public/events.js";
import { withConnectedSession } from "./connected-session.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
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

export type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => ReturnType<AcpClient["setSessionModel"]>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
  setResolvedSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type SettledAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
type FailedAttempt = Extract<SettledAttempt<unknown>, { ok: false }>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

class AsyncEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private readonly waits: Deferred<AcpRuntimeEvent | null>[] = [];
  private closed = false;

  push(item: AcpRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.resolve(null);
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  async next(): Promise<AcpRuntimeEvent | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    const waiter = createDeferred<AcpRuntimeEvent | null>();
    this.waits.push(waiter);
    return await waiter.promise;
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    while (true) {
      const next = await this.next();
      if (!next) {
        return;
      }
      yield next;
    }
  }
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

function toPromptInput(
  text: string,
  attachments?: AcpRuntimeTurnAttachment[],
): PromptInput | string {
  if (!attachments || attachments.length === 0) {
    return text;
  }
  const blocks: PromptInput = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.mediaType.startsWith("image/")) {
      blocks.push({
        type: "image",
        mimeType: attachment.mediaType,
        data: attachment.data,
      });
      continue;
    }
    if (attachment.mediaType.startsWith("audio/")) {
      blocks.push({
        type: "audio",
        mimeType: attachment.mediaType,
        data: attachment.data,
      });
      continue;
    }
    throw new AcpRuntimeError(
      "ACP_TURN_FAILED",
      `Unsupported ACP runtime attachment media type: ${attachment.mediaType}`,
    );
  }
  return blocks.length > 0 ? blocks : textPrompt(text);
}

function createInitialRecord(params: {
  recordId: string;
  sessionName: string;
  sessionId: string;
  agentCommand: string;
  agentArgv?: string[];
  cwd: string;
  agentSessionId?: string;
}): SessionRecord {
  const now = isoNow();
  return {
    schema: "acpx.session.v1",
    acpxRecordId: params.recordId,
    acpSessionId: params.sessionId,
    agentSessionId: params.agentSessionId,
    agentCommand: params.agentCommand,
    agentArgv: params.agentArgv,
    cwd: params.cwd,
    name: params.sessionName,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: defaultSessionEventLog(params.recordId),
    closed: false,
    closedAt: undefined,
    ...createSessionConversation(now),
    acpx: {},
  };
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

function legacyTerminalEventFromTurnResult(result: AcpRuntimeTurnResult): AcpRuntimeEvent {
  if (result.status === "failed") {
    return {
      type: "error",
      message: result.error.message,
      ...(result.error.code ? { code: result.error.code } : {}),
      ...(result.error.detailCode ? { detailCode: result.error.detailCode } : {}),
      ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
    };
  }
  return {
    type: "done",
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
  };
}

function statusSummary(record: SessionRecord): string {
  const parts = [
    `session=${record.acpxRecordId}`,
    `backendSessionId=${record.acpSessionId}`,
    record.agentSessionId ? `agentSessionId=${record.agentSessionId}` : null,
    record.pid != null ? `pid=${record.pid}` : null,
    record.closed ? "closed" : "open",
  ].filter(Boolean);
  return parts.join(" ");
}

function buildModelsField(record: SessionRecord): { models?: AcpRuntimeSessionModels } {
  const available = record.acpx?.available_models;
  const currentModelId = record.acpx?.current_model_id;
  if (!available || available.length === 0) {
    return currentModelId === undefined
      ? {}
      : { models: { currentModelId, availableModelIds: [] } };
  }
  return {
    models: {
      ...(currentModelId !== undefined ? { currentModelId } : {}),
      availableModelIds: [...available],
    },
  };
}

function tokenUsageToBreakdown(
  usage: SessionTokenUsage | undefined,
): AcpRuntimeUsageBreakdown | undefined {
  if (!usage) {
    return undefined;
  }
  const breakdown: AcpRuntimeUsageBreakdown = {};
  assignUsageBreakdownField(breakdown, "inputTokens", usage.input_tokens);
  assignUsageBreakdownField(breakdown, "outputTokens", usage.output_tokens);
  assignUsageBreakdownField(breakdown, "cachedReadTokens", usage.cache_read_input_tokens);
  assignUsageBreakdownField(breakdown, "cachedWriteTokens", usage.cache_creation_input_tokens);
  assignUsageBreakdownField(breakdown, "thoughtTokens", usage.thought_tokens);
  assignUsageBreakdownField(breakdown, "totalTokens", usage.total_tokens);
  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function assignUsageBreakdownField(
  breakdown: AcpRuntimeUsageBreakdown,
  key: keyof AcpRuntimeUsageBreakdown,
  value: number | undefined,
): void {
  if (value !== undefined) {
    breakdown[key] = value;
  }
}

function buildUsageField(record: SessionRecord): { usage?: AcpRuntimeSessionUsage } {
  const cumulative = tokenUsageToBreakdown(record.cumulative_token_usage);
  const perRequestEntries = Object.entries(record.request_token_usage ?? {})
    .map(([id, value]) => [id, tokenUsageToBreakdown(value)] as const)
    .filter(
      (entry): entry is readonly [string, AcpRuntimeUsageBreakdown] => entry[1] !== undefined,
    );
  const perRequest =
    perRequestEntries.length > 0 ? Object.fromEntries(perRequestEntries) : undefined;
  const cost = record.cumulative_cost;
  const usage: AcpRuntimeSessionUsage = {
    ...(cumulative ? { cumulative } : {}),
    ...(cost ? { cost } : {}),
    ...(perRequest ? { perRequest } : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : {};
}

function buildAvailableCommandsField(record: SessionRecord): {
  availableCommands?: AcpRuntimeAvailableCommand[];
} {
  const commands = record.acpx?.available_commands as readonly unknown[] | undefined;
  if (!commands || commands.length === 0) {
    return {};
  }
  const availableCommands = commands
    .map((command) => runtimeAvailableCommand(command))
    .filter((command): command is AcpRuntimeAvailableCommand => command !== undefined);
  return availableCommands.length > 0 ? { availableCommands } : {};
}

function runtimeAvailableCommand(command: unknown): AcpRuntimeAvailableCommand | undefined {
  if (typeof command === "string") {
    const name = command.trim();
    return name ? { name } : undefined;
  }
  const record = commandRecord(command);
  if (!record) {
    return undefined;
  }
  const name = trimmedField(record.name);
  if (!name) {
    return undefined;
  }
  const runtimeCommand: AcpRuntimeAvailableCommand = { name };
  const description = trimmedField(record.description);
  if (description) {
    runtimeCommand.description = description;
  }
  if (typeof record.has_input === "boolean") {
    runtimeCommand.hasInput = record.has_input;
  }
  return runtimeCommand;
}

function commandRecord(
  value: unknown,
): { name?: unknown; description?: unknown; has_input?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function trimmedField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function advertisedConfigOptionIds(record: SessionRecord): Set<string> | undefined {
  const configOptions = record.acpx?.config_options;
  if (!configOptions) {
    return undefined;
  }

  return new Set(
    configOptions
      .map((option) => option.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  );
}

function resolveSupportedConfigOptionId(record: SessionRecord, configId: string): string {
  const advertisedIds = advertisedConfigOptionIds(record);
  if (!advertisedIds) {
    return configId;
  }

  if (advertisedIds.has(configId)) {
    return configId;
  }

  if (configId === "thinking" && advertisedIds.has("effort")) {
    return "effort";
  }

  const supported = [...advertisedIds].toSorted();
  const supportedText = supported.length > 0 ? supported.join(", ") : "none";
  throw new AcpRuntimeError(
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    `ACP session ${record.acpxRecordId} does not advertise config option '${configId}'. Supported config options: ${supportedText}.`,
  );
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

type RuntimeTurnTask = {
  input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    mode: AcpRuntimePromptMode;
    sessionMode: "persistent" | "oneshot";
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onElicitation?: AcpElicitationHandler;
  };
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
  liveCheckpoint: LiveSessionCheckpoint;
  client: AcpClient;
  owner: RuntimeSessionOwner;
  connected: boolean;
  promptMessageId: string | undefined;
  activeSessionId: string;
};

type RuntimeSessionProjection = {
  record: SessionRecord;
  conversation: ReturnType<typeof cloneSessionConversation>;
  checkpoint: LiveSessionCheckpoint;
};

type RuntimeSessionOwner = {
  client: AcpClient;
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
  private readonly retainedSessionOwners = new Map<string, RuntimeSessionOwner>();
  private readonly pendingOneShotRecordIds = new Map<string, string>();
  private readonly ensureSessionLocks = new Map<string, Promise<void>>();
  private readonly runtimeOperationLocks = new Map<string, Promise<void>>();
  private readonly closingActiveRecords = new Set<string>();

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly deps: AcpRuntimeManagerDeps = {},
  ) {}

  private createClient(options: ConstructorParameters<typeof AcpClient>[0]): AcpClient {
    return this.deps.clientFactory?.(options) ?? new AcpClient(options);
  }

  private createSessionOwner(input: {
    client: AcpClient;
    sessionKey: string;
    mode: "persistent" | "oneshot";
  }): RuntimeSessionOwner {
    const owner: RuntimeSessionOwner = {
      ...input,
      bufferSessionUpdates: false,
      pendingSessionUpdates: [],
    };
    input.client.setEventHandlers({
      onSessionUpdate: (notification) => this.routeOwnedSessionUpdate(owner, notification),
      onClientOperation: (operation) => this.routeOwnedClientOperation(owner, operation),
    });
    return owner;
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
        turn.liveCheckpoint.request();
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
    projection.checkpoint.request();
  }

  private routeOwnedClientOperation(owner: RuntimeSessionOwner, operation: ClientOperation): void {
    const active = owner.activeTurn;
    if (!active) {
      return;
    }
    const { task, turn } = active;
    if (turn.connected) {
      turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
      turn.liveCheckpoint.request();
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
    const checkpoint = new LiveSessionCheckpoint({
      save: async () => {
        // Initialization owns publication; notifications before its model
        // selection succeeds must not create an incomplete session record.
        if (!owner.recordId) {
          return;
        }
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        applyLifecycleSnapshotToRecord(record, owner.client.getAgentLifecycleSnapshot());
        await this.refreshClosedState(record);
        await this.options.sessionStore.save(record);
      },
    });
    owner.projection = { record, conversation, checkpoint };
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
    await owner.projection?.checkpoint.flush();
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
    await owner.client.close().catch(() => {});
    await owner.projection?.checkpoint.flush().catch(() => {});
    try {
      owner.client.clearEventHandlers();
    } catch {}
  }

  private async refreshClosedState(record: SessionRecord): Promise<boolean> {
    if (!this.closingActiveRecords.has(record.acpxRecordId)) {
      return record.closed === true;
    }
    const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => undefined);
    record.closed = true;
    record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
    if (latest?.acpx) {
      record.acpx = {
        ...record.acpx,
        ...latest.acpx,
      };
    }
    return true;
  }

  private async retainPersistentSessionOwnerAfterTurn(input: {
    record: SessionRecord;
    owner: RuntimeSessionOwner;
    conversation: ReturnType<typeof cloneSessionConversation>;
    acpxState: ReturnType<typeof cloneSessionAcpxState>;
  }): Promise<boolean> {
    const { record, owner, conversation, acpxState } = input;
    if (!this.canRetainPersistentSessionOwner(owner, record)) {
      owner.activeTurn = undefined;
      return false;
    }
    this.attachIdleProjection(owner, record, conversation, acpxState);
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
      owner.mode === "persistent" &&
      !record.closed &&
      !(owner.client.hasUnresolvedPrompt?.() ?? false) &&
      owner.client.hasReusableSession(record.acpSessionId)
    );
  }

  private async withRuntimeControlSession<T>(
    record: SessionRecord,
    sessionMode: "persistent" | "oneshot",
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
    replacingConfigOption?: ConnectAndLoadSessionOptions["replacingConfigOption"],
  ): Promise<{ value: T; record: SessionRecord }> {
    const owner = await this.readRetainedSessionOwner(record, { consume: false });
    if (owner) {
      const ownedRecord = owner.projection?.record ?? record;
      try {
        const value = await run({
          client: owner.client,
          sessionId: ownedRecord.acpSessionId,
          record: ownedRecord,
        });
        this.refreshOwnedRecordLifecycle(owner, ownedRecord);
        return { value, record: ownedRecord };
      } finally {
        await this.flushSessionOwner(owner);
      }
    }

    const result = await withConnectedSession({
      sessionRecordId: record.acpxRecordId,
      loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
      saveRecord: async (connectedRecord) => await this.options.sessionStore.save(connectedRecord),
      createClient: (options) => this.createClient(options),
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      permissionPolicy: this.options.permissionPolicy,
      onPermissionRequest: this.options.onPermissionRequest,
      elicitationModes: this.options.elicitationModes,
      verbose: this.options.verbose,
      timeoutMs: this.options.timeoutMs,
      resumePolicy: resumePolicyForSessionMode(sessionMode),
      replacingConfigOption,
      run,
    });
    return {
      value: result.value,
      record: result.record,
    };
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
    const existing = await this.loadExistingRuntimeSession(input);
    if (existing && this.canReuseRuntimeSession(input, agent, existing)) {
      return await this.reuseRuntimeSession(existing.record);
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
    let record = await this.options.sessionStore.load(existingRecordId);
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
      isDeepStrictEqual(sessionOptionsFromRecord(existing.record), input.sessionOptions),
    );
  }

  private async reuseRuntimeSession(record: SessionRecord): Promise<SessionRecord> {
    // sessionOptions on a reused persistent record are intentionally ignored:
    // system prompts are fixed at newSession time. Pending one-shot records are
    // reused only when their options still match.
    record.closed = false;
    record.closedAt = undefined;
    this.closingActiveRecords.delete(record.acpxRecordId);
    await this.options.sessionStore.save(record);
    return record;
  }

  private async closeConflictingPersistentSession(
    input: RuntimeEnsureInput,
    owner: RuntimeSessionOwner | undefined,
  ): Promise<void> {
    if (input.mode === "persistent" && owner?.recordId) {
      await this.closeRetainedSessionOwner(owner.recordId);
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
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      permissionPolicy: this.options.permissionPolicy,
      onPermissionRequest: this.options.onPermissionRequest,
      elicitationModes: this.options.elicitationModes,
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
      await client.start();
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
        await client.close();
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
    const record = createInitialRecord({
      recordId: createRecordId(input.sessionKey, input.mode),
      sessionName: input.sessionKey,
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
    applyConfigOptionsToRecord(record, modelApplication.response);
    syncAdvertisedModelState(
      record,
      modelApplication.response
        ? modelStateFromConfigOptions(modelApplication.response.configOptions)
        : session.sessionResult.models,
    );
    if (modelApplication.applied) {
      setCurrentModelId(
        record,
        currentModelIdFromSetModelResponse(modelApplication.response, input.sessionOptions?.model),
      );
    }
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
    await owner.projection?.checkpoint.checkpoint();
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

  startTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    mode: AcpRuntimePromptMode;
    sessionMode: "persistent" | "oneshot";
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onElicitation?: AcpElicitationHandler;
  }): AcpRuntimeTurn {
    let promptInput: PromptInput | string;
    try {
      promptInput = toPromptInput(input.text, input.attachments);
    } catch (error) {
      void this.closeRetainedOneShotHandle(input.handle).catch(() => {});
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
      void requestCancel();
    };
    if (input.signal) {
      if (input.signal.aborted) {
        promptStarted.reject(new Error("ACP turn cancelled before prompt submission."));
        closeStream();
        void this.closeRetainedOneShotHandle(input.handle)
          .catch(() => {})
          .then(() => {
            settleResult({
              status: "cancelled",
              stopReason: "cancelled",
            });
          });
        return {
          requestId: input.requestId,
          promptStarted: promptStarted.promise,
          events: queue.iterate(),
          result: result.promise,
          cancel: async () => {},
          closeStream: async () => {},
        };
      }
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }

    void this.runRuntimeTurnTask({
      input,
      promptInput,
      queue,
      promptStarted,
      sessionReady,
      state,
      settleResult,
      abortHandler,
    });

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
    const owner = this.retainedSessionOwners.get(recordId);
    if (owner?.mode === "oneshot") {
      await this.closeRetainedSessionOwner(recordId);
    }
  }

  private async runRuntimeTurnTask(task: RuntimeTurnTask): Promise<void> {
    let turn: RunningRuntimeTurn | undefined;
    let terminalResult: AcpRuntimeTurnResult;
    try {
      turn = await this.prepareRuntimeTurn(task);
      const { sessionId, resumed, loadError } = await this.connectRuntimeTurn(task, turn);
      await this.resolveRuntimeTurnReady(task, turn, resumed, loadError);
      if (this.cancelRuntimeTurnBeforePrompt(task)) {
        terminalResult = {
          status: "cancelled",
          stopReason: "cancelled",
        };
      } else {
        await this.applyPendingRuntimeTurnCancel(task, turn);
        const response = await this.runRuntimePrompt(task, turn, sessionId);
        await this.saveCompletedRuntimeTurn(turn, response.stopReason);
        terminalResult = {
          status: response.stopReason === "cancelled" ? "cancelled" : "completed",
          ...(response.stopReason ? { stopReason: response.stopReason } : {}),
          ...(response._meta === undefined ? {} : { _meta: response._meta }),
        };
      }
    } catch (error) {
      terminalResult = this.failRuntimeTurn(task, error);
    }
    try {
      await this.finalizeRuntimeTurn(task, turn);
    } catch (error) {
      terminalResult = this.failRuntimeTurn(task, error);
    }
    task.settleResult(terminalResult);
  }

  private async runRuntimePrompt(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
    sessionId: string,
  ): ReturnType<typeof runPromptTurn> {
    try {
      return await runPromptTurn({
        client: turn.client,
        sessionId,
        prompt: task.promptInput,
        timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
        conversation: turn.conversation,
        promptMessageId: turn.promptMessageId,
        onPromptRequestStarted: () => task.promptStarted.resolve(),
        onElicitation: task.input.onElicitation,
      });
    } finally {
      turn.client.endPromptElicitation?.(sessionId);
    }
  }

  private async prepareRuntimeTurn(task: RuntimeTurnTask): Promise<RunningRuntimeTurn> {
    const recordId = task.input.handle.acpxRecordId ?? task.input.handle.sessionKey;
    return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () =>
      this.prepareRuntimeTurnWithOwnership(task),
    );
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
    const projection = retainedOwner.projection;
    if (projection) {
      record = structuredClone(projection.record);
    }
    retainedOwner.bufferSessionUpdates = true;
    return { record, retainedOwner };
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
      liveCheckpoint: this.createRuntimeTurnCheckpoint(record, conversation, () => turn.acpxState),
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
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      permissionPolicy: this.options.permissionPolicy,
      onPermissionRequest: this.options.onPermissionRequest,
      elicitationModes: this.options.elicitationModes,
      verbose: this.options.verbose,
      sessionOptions: sessionOptionsFromRecord(record),
    });
  }

  private createRuntimeTurnCheckpoint(
    record: SessionRecord,
    conversation: ReturnType<typeof cloneSessionConversation>,
    readAcpxState: () => ReturnType<typeof cloneSessionAcpxState>,
  ): LiveSessionCheckpoint {
    return new LiveSessionCheckpoint({
      save: async () => {
        record.lastUsedAt = isoNow();
        record.acpx = readAcpxState();
        applyConversation(record, conversation);
        await this.refreshClosedState(record);
        await this.options.sessionStore.save(record);
      },
    });
  }

  private buildRuntimeTurnController(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): ActiveSessionController {
    return {
      hasActivePrompt: () => turn.client.hasActivePrompt(),
      requestCancelActivePrompt: async () => await this.requestRuntimeTurnCancel(task, turn),
      setSessionMode: async (modeId: string) => {
        await this.waitForRuntimeControlSession(task, turn);
        await turn.client.setSessionMode(turn.activeSessionId, modeId);
        const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
        nextState.desired_mode_id = modeId;
        turn.acpxState = nextState;
      },
      setSessionModel: async (modelId: string) => {
        await this.waitForRuntimeControlSession(task, turn);
        const models = advertisedModelState(turn.acpxState);
        const response = await turn.client.setSessionModel(turn.activeSessionId, modelId, models);
        turn.acpxState = applyModelSelection(turn.acpxState, modelId, response);
        return response;
      },
      setSessionConfigOption: async (configId: string, value: string) => {
        const result = await task.state.activeController!.setResolvedSessionConfigOption(
          configId,
          value,
        );
        return result.response;
      },
      setResolvedSessionConfigOption: async (configId: string, value: string) =>
        await this.setRuntimeResolvedSessionConfigOption(task, turn, configId, value),
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
    const modelConfigId = advertisedModelState(turn.acpxState)?.configId;
    const response = await turn.client.setSessionConfigOption(
      turn.activeSessionId,
      resolvedConfigId,
      value,
    );
    turn.acpxState = applyConfigOptionSelection(
      turn.acpxState,
      resolvedConfigId,
      value,
      response,
      modelConfigId,
    );
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
    resumed: boolean,
    loadError: string | undefined,
  ): Promise<void> {
    task.sessionReady.resolve();
    turn.record.lastRequestId = task.input.requestId;
    turn.record.lastPromptAt = isoNow();
    turn.record.closed = false;
    turn.record.closedAt = undefined;
    turn.record.lastUsedAt = isoNow();
    await turn.liveCheckpoint.checkpoint();
    this.emitRuntimeTurnLoadStatus(task, resumed, loadError);
  }

  private emitRuntimeTurnLoadStatus(
    task: RuntimeTurnTask,
    resumed: boolean,
    loadError: string | undefined,
  ): void {
    if (!resumed && !loadError) {
      return;
    }
    this.emitRuntimeTurnEvent(task, {
      type: "status",
      text: loadError ? `session reconnect fallback: ${loadError}` : "session resumed",
    });
  }

  private cancelRuntimeTurnBeforePrompt(task: RuntimeTurnTask): boolean {
    if (!task.state.pendingCancel && !task.input.signal?.aborted) {
      return false;
    }
    task.state.pendingCancel = false;
    task.promptStarted.reject(new Error("ACP turn cancelled before prompt submission."));
    return true;
  }

  private async applyPendingRuntimeTurnCancel(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn,
  ): Promise<boolean> {
    if (!task.state.pendingCancel || !turn.client.hasActivePrompt()) {
      return false;
    }
    const cancelled = await turn.client.requestCancelActivePrompt();
    if (cancelled) {
      task.state.pendingCancel = false;
    }
    return cancelled;
  }

  private async saveCompletedRuntimeTurn(
    turn: RunningRuntimeTurn,
    _stopReason: string | undefined,
  ): Promise<void> {
    turn.record.acpSessionId = turn.activeSessionId;
    reconcileAgentSessionId(turn.record, turn.record.agentSessionId);
    turn.record.protocolVersion = turn.client.initializeResult?.protocolVersion;
    turn.record.agentCapabilities = turn.client.initializeResult?.agentCapabilities;
    turn.record.acpx = turn.acpxState;
    applyConversation(turn.record, turn.conversation);
    applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
    await this.options.sessionStore.save(turn.record);
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
      turn.owner.activeTurn = undefined;
    }
  }

  private async closeRuntimeTurnClient(
    turn: RunningRuntimeTurn | undefined,
    pooled: boolean,
  ): Promise<void> {
    if (!turn || pooled) {
      return;
    }
    turn.owner.activeTurn = undefined;
    const clearAttempt = await settleAttempt(() => turn.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => turn.client.close());
    const failure = firstFailedAttempt([clearAttempt, closeAttempt]);
    if (failure) {
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
    applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
    turn.record.acpx = turn.acpxState;
    applyConversation(turn.record, turn.conversation);
    turn.record.lastUsedAt = isoNow();
    await turn.liveCheckpoint.flush();
    const closed = await this.refreshClosedState(turn.record);
    await this.options.sessionStore.save(turn.record);
    // A loaded transport is not reusable until preference reconciliation succeeds.
    if (closed || !turn.connected) {
      return false;
    }
    return await this.retainPersistentSessionOwnerAfterTurn({
      record: turn.record,
      owner: turn.owner,
      conversation: turn.conversation,
      acpxState: turn.acpxState,
    });
  }

  async *runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    mode: AcpRuntimePromptMode;
    sessionMode: "persistent" | "oneshot";
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onElicitation?: AcpElicitationHandler;
  }): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    yield* turn.events;
    yield legacyTerminalEventFromTurnResult(await turn.result);
  }

  async getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const owner = this.retainedSessionOwners.get(recordId);
    if (owner) {
      await this.flushSessionOwner(owner);
    }
    const record = await this.requireRecord(recordId);
    return {
      summary: statusSummary(record),
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      ...buildModelsField(record),
      ...buildUsageField(record),
      ...buildAvailableCommandsField(record),
      details: {
        cwd: record.cwd,
        lastUsedAt: record.lastUsedAt,
        closed: record.closed === true,
        ...(record.acpx?.config_options !== undefined
          ? { configOptions: structuredClone(record.acpx.config_options) }
          : {}),
      },
    };
  }

  async setMode(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    await this.withManagerLock(this.runtimeOperationLocks, recordId, async () =>
      this.setModeWithOwnership(handle, mode, sessionMode),
    );
  }

  private async setModeWithOwnership(
    handle: AcpRuntimeHandle,
    mode: string,
    sessionMode: "persistent" | "oneshot",
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    const controller = this.activeControllers.get(record.acpxRecordId);
    let targetRecord = record;
    if (controller) {
      await controller.setSessionMode(mode);
    } else {
      const result = await this.withRuntimeControlSession(
        record,
        sessionMode,
        async ({ client, sessionId }) => {
          await client.setSessionMode(sessionId, mode);
        },
      );
      targetRecord = result.record;
    }
    setDesiredModeId(targetRecord, mode);
    await this.options.sessionStore.save(targetRecord);
  }

  async setConfigOption(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot" = "persistent",
  ): Promise<SetSessionConfigOptionResponse> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    return await this.withManagerLock(this.runtimeOperationLocks, recordId, async () =>
      this.setConfigOptionWithOwnership(handle, key, value, sessionMode),
    );
  }

  private async setConfigOptionWithOwnership(
    handle: AcpRuntimeHandle,
    key: string,
    value: string,
    sessionMode: "persistent" | "oneshot",
  ): Promise<SetSessionConfigOptionResponse> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      const { configId, response } = await controller.setResolvedSessionConfigOption(key, value);
      record.acpx = applyConfigOptionSelection(record.acpx, configId, value, response);
      await this.options.sessionStore.save(record);
      return response;
    }

    const result = await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const configId = resolveSupportedConfigOptionId(connectedRecord, key);
        const modelConfigId = advertisedModelState(connectedRecord.acpx)?.configId;
        const response = await client.setSessionConfigOption(sessionId, configId, value);
        connectedRecord.acpx = applyConfigOptionSelection(
          connectedRecord.acpx,
          configId,
          value,
          response,
          modelConfigId,
        );
        return response;
      },
      { key, resolve: (connectedRecord) => resolveSupportedConfigOptionId(connectedRecord, key) },
    );
    await this.options.sessionStore.save(result.record);
    return result.value;
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  async close(
    handle: AcpRuntimeHandle,
    options: { discardPersistentState?: boolean } = {},
  ): Promise<void> {
    const recordId = handle.acpxRecordId ?? handle.sessionKey;
    const record = await this.resolveRuntimeRecordForClose(recordId);
    this.markActiveRuntimeRecordClosing(record);
    await this.cancel(handle);
    await this.closeRuntimeRecordOwnership(record, options.discardPersistentState === true);
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
    discardPersistentState: boolean,
  ): Promise<void> {
    if (discardPersistentState) {
      await this.closeBackendSession(record);
      record.acpx = {
        ...record.acpx,
        reset_on_next_ensure: true,
      };
    } else {
      await this.closeRetainedSessionOwner(record.acpxRecordId);
    }
  }

  private async closeBackendSession(record: SessionRecord): Promise<void> {
    const connection = await this.acquireBackendCloseConnection(record);

    try {
      await this.requestBackendSessionClose(record, connection);
    } catch (error) {
      this.handleBackendSessionCloseError(record, error);
    } finally {
      await this.finalizeBackendCloseConnection(connection);
    }
  }

  private async finalizeBackendCloseConnection(connection: {
    client: AcpClient;
    owner?: RuntimeSessionOwner;
  }): Promise<void> {
    const flushAttempt = await settleAttempt(async () => {
      if (connection.owner) {
        await this.flushSessionOwner(connection.owner);
      }
    });
    const clearAttempt = await settleAttempt(() => connection.owner?.client.clearEventHandlers());
    const closeAttempt = await settleAttempt(async () => connection.client.close());
    const failure = firstFailedAttempt([flushAttempt, clearAttempt, closeAttempt]);
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
      client: this.createClient({
        agentCommand: record.agentCommand,
        agentArgv: record.agentArgv,
        cwd: record.cwd,
        mcpServers: [...(this.options.mcpServers ?? [])],
        permissionMode: this.options.permissionMode,
        nonInteractivePermissions: this.options.nonInteractivePermissions,
        permissionPolicy: this.options.permissionPolicy,
        onPermissionRequest: this.options.onPermissionRequest,
        elicitationModes: this.options.elicitationModes,
        verbose: this.options.verbose,
      }),
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
