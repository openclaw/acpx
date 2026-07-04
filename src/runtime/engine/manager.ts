import { randomUUID } from "node:crypto";
import path from "node:path";
import { AcpClient } from "../../acp/client.js";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { extractAcpError, isAcpResourceNotFoundError } from "../../acp/error-shapes.js";
import { modelStateFromConfigOptions } from "../../acp/model-support.js";
import { withTimeout } from "../../async-control.js";
import { textPrompt, type PromptInput } from "../../prompt-content.js";
import {
  applyConfigOptionsToRecord,
  applyConfigOptionsToState,
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
  clearDesiredConfigOption,
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModelId,
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
import { connectAndLoadSession, type ConnectAndLoadSessionResult } from "./reconnect.js";
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

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  };
  promptInput: PromptInput | string;
  queue: AsyncEventQueue;
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
  pendingClient: AcpClient | undefined;
  promptMessageId: string | undefined;
  activeSessionId: string;
};

function applyConfigOptionResponseToTurn(
  turn: RunningRuntimeTurn,
  response:
    | Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>
    | Awaited<ReturnType<AcpClient["setSessionModel"]>>,
): void {
  if (!response?.configOptions) {
    return;
  }
  turn.acpxState = applyConfigOptionsToState(turn.acpxState, response.configOptions);
}

function applyDesiredConfigOptionToTurn(
  turn: RunningRuntimeTurn,
  configId: string,
  value: string,
): void {
  const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
  const modelConfigId = modelStateFromConfigOptions(nextState.config_options)?.configId;
  if (configId === modelConfigId) {
    nextState.session_options = { ...nextState.session_options, model: value };
    clearDesiredConfigOption(nextState, configId);
  } else if (configId === "mode") {
    nextState.desired_mode_id = value;
  } else {
    nextState.desired_config_options = {
      ...nextState.desired_config_options,
      [configId]: value,
    };
  }
  turn.acpxState = nextState;
}

function applyDesiredConfigOptionToRecord(
  record: SessionRecord,
  configId: string,
  value: string,
): void {
  const modelConfigId = modelStateFromConfigOptions(record.acpx?.config_options)?.configId;
  if (configId === modelConfigId) {
    setDesiredModelId(record, value, configId);
  } else if (configId === "mode") {
    setDesiredModeId(record, value);
  } else {
    setDesiredConfigOption(record, configId, value);
  }
}

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
  private readonly pendingPersistentClients = new Map<string, AcpClient>();
  private readonly closingActiveRecords = new Set<string>();

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly deps: AcpRuntimeManagerDeps = {},
  ) {}

  private createClient(options: ConstructorParameters<typeof AcpClient>[0]): AcpClient {
    return this.deps.clientFactory?.(options) ?? new AcpClient(options);
  }

  private async readPendingPersistentClient(
    record: SessionRecord,
    options: { consume: boolean },
  ): Promise<AcpClient | undefined> {
    const pendingClient = this.pendingPersistentClients.get(record.acpxRecordId);
    if (!pendingClient) {
      return undefined;
    }
    if (!pendingClient.hasReusableSession(record.acpSessionId)) {
      this.pendingPersistentClients.delete(record.acpxRecordId);
      await pendingClient.close().catch(() => {});
      return undefined;
    }
    if (options.consume) {
      this.pendingPersistentClients.delete(record.acpxRecordId);
    }
    return pendingClient;
  }

  private async closePendingPersistentClient(recordId: string): Promise<void> {
    const pendingClient = this.pendingPersistentClients.get(recordId);
    if (!pendingClient) {
      return;
    }
    this.pendingPersistentClients.delete(recordId);
    await pendingClient.close().catch(() => {});
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

  private async retainPersistentClientAfterTurn(input: {
    record: SessionRecord;
    client: AcpClient;
  }): Promise<boolean> {
    const { record, client } = input;
    const isPersistentRecord = !record.acpxRecordId.includes(":oneshot:");
    if (!isPersistentRecord || record.closed || !client.hasReusableSession(record.acpSessionId)) {
      return false;
    }
    const previousClient = this.pendingPersistentClients.get(record.acpxRecordId);
    this.pendingPersistentClients.set(record.acpxRecordId, client);
    if (previousClient && previousClient !== client) {
      await previousClient.close().catch(() => {});
    }
    return true;
  }

  private async withRuntimeControlSession<T>(
    record: SessionRecord,
    sessionMode: "persistent" | "oneshot",
    run: (context: { client: AcpClient; sessionId: string; record: SessionRecord }) => Promise<T>,
  ): Promise<{ value: T; record: SessionRecord }> {
    const pendingClient = await this.readPendingPersistentClient(record, { consume: false });
    if (pendingClient) {
      const value = await run({
        client: pendingClient,
        sessionId: record.acpSessionId,
        record,
      });
      record.lastUsedAt = isoNow();
      record.closed = false;
      record.closedAt = undefined;
      record.protocolVersion = pendingClient.initializeResult?.protocolVersion;
      record.agentCapabilities = pendingClient.initializeResult?.agentCapabilities;
      applyLifecycleSnapshotToRecord(record, pendingClient.getAgentLifecycleSnapshot());
      return { value, record };
    }

    const result = await withConnectedSession({
      sessionRecordId: record.acpxRecordId,
      loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
      saveRecord: async (connectedRecord) => await this.options.sessionStore.save(connectedRecord),
      createClient: (options) => this.createClient(options),
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onPermissionRequest: this.options.onPermissionRequest,
      verbose: this.options.verbose,
      timeoutMs: this.options.timeoutMs,
      resumePolicy: resumePolicyForSessionMode(sessionMode),
      run,
    });
    return {
      value: result.value,
      record: result.record,
    };
  }
  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
    sessionOptions?: SessionAgentOptions;
  }): Promise<SessionRecord> {
    const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
    const agentCommand = this.options.agentRegistry.resolve(input.agent);
    const existing = await this.options.sessionStore.load(input.sessionKey);
    if (
      input.mode === "persistent" &&
      existing &&
      shouldReuseExistingRecord(existing, {
        cwd,
        agentCommand,
        resumeSessionId: input.resumeSessionId,
      })
    ) {
      // sessionOptions on a reused record are intentionally ignored: system
      // prompts are fixed at newSession time; callers who need a different
      // prompt must use a distinct sessionKey or close the prior record.
      existing.closed = false;
      existing.closedAt = undefined;
      this.closingActiveRecords.delete(existing.acpxRecordId);
      await this.options.sessionStore.save(existing);
      return existing;
    }

    const client = this.createClient({
      agentCommand,
      cwd,
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onPermissionRequest: this.options.onPermissionRequest,
      verbose: this.options.verbose,
      sessionOptions: input.sessionOptions,
    });
    let keepClientOpen = false;

    try {
      await client.start();
      const session = await createOrLoadRuntimeSession(client, input.resumeSessionId, cwd);
      const record = await this.createAndSaveRuntimeRecord({
        input,
        client,
        agentCommand,
        cwd,
        session,
      });
      keepClientOpen = await this.keepPersistentClient(input.mode, record.acpxRecordId, client);
      return record;
    } finally {
      if (!keepClientOpen) {
        await client.close();
      }
    }
  }

  private async createAndSaveRuntimeRecord(params: {
    input: {
      sessionKey: string;
      mode: "persistent" | "oneshot";
      sessionOptions?: SessionAgentOptions;
    };
    client: AcpClient;
    agentCommand: string;
    cwd: string;
    session: CreatedRuntimeSession;
  }): Promise<SessionRecord> {
    const { input, client, agentCommand, cwd, session } = params;
    const record = createInitialRecord({
      recordId: createRecordId(input.sessionKey, input.mode),
      sessionName: input.sessionKey,
      sessionId: session.sessionId,
      agentCommand,
      cwd,
      agentSessionId: session.agentSessionId,
    });
    this.closingActiveRecords.delete(record.acpxRecordId);
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
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
    await this.options.sessionStore.save(record);
    return record;
  }

  private async keepPersistentClient(
    mode: "persistent" | "oneshot",
    recordId: string,
    client: AcpClient,
  ): Promise<boolean> {
    if (mode !== "persistent") {
      return false;
    }
    const previousClient = this.pendingPersistentClients.get(recordId);
    this.pendingPersistentClients.set(recordId, client);
    await previousClient?.close().catch(() => {});
    return true;
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
  }): AcpRuntimeTurn {
    const promptInput = toPromptInput(input.text, input.attachments);
    const queue = new AsyncEventQueue();
    const result = createDeferred<AcpRuntimeTurnResult>();
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
        closeStream();
        settleResult({
          status: "cancelled",
          stopReason: "cancelled",
        });
        return {
          requestId: input.requestId,
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
      sessionReady,
      state,
      settleResult,
      abortHandler,
    });

    return {
      requestId: input.requestId,
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

  private async runRuntimeTurnTask(task: RuntimeTurnTask): Promise<void> {
    let turn: RunningRuntimeTurn | undefined;
    try {
      turn = await this.prepareRuntimeTurn(task);
      const { sessionId, resumed, loadError } = await this.connectRuntimeTurn(task, turn);
      await this.resolveRuntimeTurnReady(task, turn, resumed, loadError);
      if (this.cancelRuntimeTurnBeforePrompt(task)) {
        return;
      }
      await this.applyPendingRuntimeTurnCancel(task, turn);
      const response = await runPromptTurn({
        client: turn.client,
        sessionId,
        prompt: task.promptInput,
        timeoutMs: task.input.timeoutMs ?? this.options.timeoutMs,
        conversation: turn.conversation,
        promptMessageId: turn.promptMessageId,
      });
      await this.saveCompletedRuntimeTurn(turn, response.stopReason);
      task.settleResult({
        status: response.stopReason === "cancelled" ? "cancelled" : "completed",
        ...(response.stopReason ? { stopReason: response.stopReason } : {}),
      });
    } catch (error) {
      this.failRuntimeTurn(task, error);
    } finally {
      await this.finalizeRuntimeTurn(task, turn);
    }
  }

  private async prepareRuntimeTurn(task: RuntimeTurnTask): Promise<RunningRuntimeTurn> {
    const record = await this.requireRecord(
      task.input.handle.acpxRecordId ?? task.input.handle.sessionKey,
    );
    const conversation = cloneSessionConversation(record);
    let acpxState = cloneSessionAcpxState(record.acpx);
    const promptStartedAt = isoNow();
    const promptMessageId = recordPromptSubmission(conversation, task.promptInput, promptStartedAt);
    trimConversationForRuntime(conversation);
    record.lastPromptAt = promptStartedAt;
    record.lastUsedAt = promptStartedAt;
    record.acpx = acpxState;
    applyConversation(record, conversation);
    await this.options.sessionStore.save(record);

    const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
    const client = pendingClient ?? this.createTurnClient(record);
    const turn: RunningRuntimeTurn = {
      record,
      conversation,
      acpxState,
      liveCheckpoint: this.createRuntimeTurnCheckpoint(record, conversation, () => turn.acpxState),
      client,
      pendingClient,
      promptMessageId,
      activeSessionId: record.acpSessionId,
    };
    task.state.activeController = this.buildRuntimeTurnController(task, turn);
    this.activeControllers.set(record.acpxRecordId, task.state.activeController);
    this.installRuntimeTurnEventHandlers(task, turn);
    return turn;
  }

  private createTurnClient(record: SessionRecord): AcpClient {
    return this.createClient({
      agentCommand: record.agentCommand,
      cwd: record.cwd,
      mcpServers: [...(this.options.mcpServers ?? [])],
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onPermissionRequest: this.options.onPermissionRequest,
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
        applyConfigOptionResponseToTurn(turn, response);
        const nextState = cloneSessionAcpxState(turn.acpxState) ?? {};
        nextState.session_options = { ...nextState.session_options, model: modelId };
        nextState.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
        clearDesiredConfigOption(nextState, models?.configId);
        turn.acpxState = nextState;
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
    const response = await turn.client.setSessionConfigOption(
      turn.activeSessionId,
      resolvedConfigId,
      value,
    );
    this.applyRuntimeConfigOptionState(turn, resolvedConfigId, value, response);
    return { configId: resolvedConfigId, response };
  }

  private applyRuntimeConfigOptionState(
    turn: RunningRuntimeTurn,
    configId: string,
    value: string,
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>,
  ): void {
    applyConfigOptionResponseToTurn(turn, response);
    applyDesiredConfigOptionToTurn(turn, configId, value);
  }

  private installRuntimeTurnEventHandlers(task: RuntimeTurnTask, turn: RunningRuntimeTurn): void {
    turn.client.setEventHandlers({
      onSessionUpdate: (notification) => {
        turn.acpxState = recordSessionUpdate(turn.conversation, turn.acpxState, notification);
        trimConversationForRuntime(turn.conversation);
        turn.liveCheckpoint.request();
        this.emitRuntimeTurnEvent(task, {
          jsonrpc: "2.0",
          method: "session/update",
          params: notification,
        });
      },
      onClientOperation: (operation: ClientOperation) => {
        turn.acpxState = recordClientOperation(turn.conversation, turn.acpxState, operation);
        trimConversationForRuntime(turn.conversation);
        turn.liveCheckpoint.request();
        this.emitRuntimeTurnEvent(task, {
          type: "client_operation",
          ...operation,
        });
      },
    });
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
    const loaded = turn.pendingClient
      ? { sessionId: turn.record.acpSessionId, resumed: false, loadError: undefined }
      : await this.connectRuntimeTurnClient(task, turn);
    turn.acpxState = cloneSessionAcpxState(turn.record.acpx);
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
    task.settleResult({
      status: "cancelled",
      stopReason: "cancelled",
    });
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

  private failRuntimeTurn(task: RuntimeTurnTask, error: unknown): void {
    task.sessionReady.reject(error);
    const normalized = normalizeOutputError(error, { origin: "runtime" });
    task.settleResult({
      status: "failed",
      error: {
        message: normalized.message,
        ...(normalized.code ? { code: normalized.code } : {}),
        ...(normalized.detailCode ? { detailCode: normalized.detailCode } : {}),
        ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
      },
    });
  }

  private async finalizeRuntimeTurn(
    task: RuntimeTurnTask,
    turn: RunningRuntimeTurn | undefined,
  ): Promise<void> {
    task.state.turnActive = false;
    task.input.signal?.removeEventListener("abort", task.abortHandler);
    turn?.client.clearEventHandlers();
    const pooled = turn ? await this.finalizeRuntimeTurnRecord(turn) : false;
    if (!pooled) {
      await turn?.client.close().catch(() => {});
    }
    if (turn) {
      this.activeControllers.delete(turn.record.acpxRecordId);
      this.closingActiveRecords.delete(turn.record.acpxRecordId);
    }
    task.queue.close();
  }

  private async finalizeRuntimeTurnRecord(turn: RunningRuntimeTurn): Promise<boolean> {
    applyLifecycleSnapshotToRecord(turn.record, turn.client.getAgentLifecycleSnapshot());
    turn.record.acpx = turn.acpxState;
    applyConversation(turn.record, turn.conversation);
    turn.record.lastUsedAt = isoNow();
    await turn.liveCheckpoint.flush().catch(() => {});
    const closed = await this.refreshClosedState(turn.record);
    await this.options.sessionStore.save(turn.record).catch(() => {});
    if (closed) {
      return false;
    }
    return await this.retainPersistentClientAfterTurn({
      record: turn.record,
      client: turn.client,
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
  }): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    yield* turn.events;
    yield legacyTerminalEventFromTurnResult(await turn.result);
  }

  async getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
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
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    const controller = this.activeControllers.get(record.acpxRecordId);
    if (controller) {
      const { configId, response } = await controller.setResolvedSessionConfigOption(key, value);
      applyConfigOptionsToRecord(record, response);
      applyDesiredConfigOptionToRecord(record, configId, value);
      await this.options.sessionStore.save(record);
      return;
    }

    const result = await this.withRuntimeControlSession(
      record,
      sessionMode,
      async ({ client, sessionId, record: connectedRecord }) => {
        const configId = resolveSupportedConfigOptionId(connectedRecord, key);
        const response = await client.setSessionConfigOption(sessionId, configId, value);
        applyConfigOptionsToRecord(connectedRecord, response);
        applyDesiredConfigOptionToRecord(connectedRecord, configId, value);
      },
    );
    await this.options.sessionStore.save(result.record);
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  async close(
    handle: AcpRuntimeHandle,
    options: { discardPersistentState?: boolean } = {},
  ): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    if (this.activeControllers.has(record.acpxRecordId)) {
      this.closingActiveRecords.add(record.acpxRecordId);
    }
    await this.cancel(handle);
    if (options.discardPersistentState) {
      await this.closeBackendSession(record);
      record.acpx = {
        ...record.acpx,
        reset_on_next_ensure: true,
      };
    } else {
      await this.closePendingPersistentClient(record.acpxRecordId);
    }
    record.closed = true;
    record.closedAt = isoNow();
    await this.options.sessionStore.save(record);
  }

  private async closeBackendSession(record: SessionRecord): Promise<void> {
    const pendingClient = await this.readPendingPersistentClient(record, { consume: true });

    const client =
      pendingClient ??
      this.createClient({
        agentCommand: record.agentCommand,
        cwd: record.cwd,
        mcpServers: [...(this.options.mcpServers ?? [])],
        permissionMode: this.options.permissionMode,
        nonInteractivePermissions: this.options.nonInteractivePermissions,
        onPermissionRequest: this.options.onPermissionRequest,
        verbose: this.options.verbose,
      });

    try {
      if (!pendingClient) {
        await withTimeout(client.start(), this.options.timeoutMs);
      }
      if (!client.supportsCloseSession()) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `Agent does not support session/close for ${record.acpxRecordId}.`,
        );
      }
      await withTimeout(client.closeSession(record.acpSessionId), this.options.timeoutMs);
    } catch (error) {
      if (isUnsupportedSessionCloseError(error)) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `Agent does not support session/close for ${record.acpxRecordId}.`,
          { cause: error },
        );
      }
      if (isAcpResourceNotFoundError(error)) {
        return;
      }
      throw error;
    } finally {
      await client.close().catch(() => {});
    }
  }

  private async requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.options.sessionStore.load(sessionId);
    if (!record) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return record;
  }
}
