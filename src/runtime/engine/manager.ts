import { randomUUID } from "node:crypto";
import path from "node:path";
import { AcpClient } from "../../acp/client.js";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { extractAcpError, isAcpResourceNotFoundError } from "../../acp/error-shapes.js";
import { withTimeout } from "../../async-control.js";
import { textPrompt, type PromptInput } from "../../prompt-content.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
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
  setDesiredConfigOption,
  setDesiredModeId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import type { ClientOperation, SessionRecord, SessionResumePolicy } from "../../types.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimePromptMode,
  AcpRuntimeSessionModels,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
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
import { connectAndLoadSession } from "./reconnect.js";
import { shouldReuseExistingRecord } from "./reuse-policy.js";
import { persistSessionOptions, type SessionAgentOptions } from "./session-options.js";

export type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
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
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
  > = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (!attachment.mediaType.startsWith("image/")) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        `Unsupported ACP runtime attachment media type: ${attachment.mediaType}`,
      );
    }
    blocks.push({
      type: "image",
      mimeType: attachment.mediaType,
      data: attachment.data,
    });
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
      verbose: this.options.verbose,
      sessionOptions: input.sessionOptions,
    });
    let keepClientOpen = false;

    try {
      await client.start();
      let sessionId: string;
      let agentSessionId: string | undefined;
      let sessionResult:
        | Awaited<ReturnType<AcpClient["createSession"]>>
        | Awaited<ReturnType<AcpClient["loadSession"]>>;
      if (input.resumeSessionId) {
        const loaded = await client.loadSession(input.resumeSessionId, cwd);
        sessionId = input.resumeSessionId;
        agentSessionId = loaded.agentSessionId;
        sessionResult = loaded;
      } else {
        const created = await client.createSession(cwd);
        sessionId = created.sessionId;
        agentSessionId = created.agentSessionId;
        sessionResult = created;
      }
      const record = createInitialRecord({
        recordId: createRecordId(input.sessionKey, input.mode),
        sessionName: input.sessionKey,
        sessionId,
        agentCommand,
        cwd,
        agentSessionId,
      });
      this.closingActiveRecords.delete(record.acpxRecordId);
      record.protocolVersion = client.initializeResult?.protocolVersion;
      record.agentCapabilities = client.initializeResult?.agentCapabilities;
      applyConfigOptionsToRecord(record, sessionResult);
      const requestedModelApplied = await applyRequestedModelIfAdvertised({
        client,
        sessionId,
        requestedModel: input.sessionOptions?.model,
        models: sessionResult.models,
        agentCommand,
        timeoutMs: this.options.timeoutMs,
      });
      syncAdvertisedModelState(record, sessionResult.models);
      if (requestedModelApplied) {
        setCurrentModelId(record, input.sessionOptions?.model);
      }
      applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
      persistSessionOptions(record, input.sessionOptions);
      await this.options.sessionStore.save(record);
      if (input.mode === "persistent") {
        const previousClient = this.pendingPersistentClients.get(record.acpxRecordId);
        this.pendingPersistentClients.set(record.acpxRecordId, client);
        keepClientOpen = true;
        await previousClient?.close().catch(() => {});
      }
      return record;
    } finally {
      if (!keepClientOpen) {
        await client.close();
      }
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
  }): AcpRuntimeTurn {
    const promptInput = toPromptInput(input.text, input.attachments);
    const queue = new AsyncEventQueue();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const sessionReady = createDeferred<void>();
    void sessionReady.promise.catch(() => {});
    let resultSettled = false;
    let pendingCancel = false;
    let turnActive = true;
    let streamClosed = false;
    let activeController: ActiveSessionController | null = null;

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
      if (activeController) {
        return await activeController.requestCancelActivePrompt();
      }
      if (!turnActive) {
        return false;
      }
      pendingCancel = true;
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

    void (async () => {
      let record: SessionRecord | null = null;
      let conversation: ReturnType<typeof cloneSessionConversation> | null = null;
      let acpxState: ReturnType<typeof cloneSessionAcpxState>;
      let liveCheckpoint: LiveSessionCheckpoint | undefined;
      let client: AcpClient | null = null;
      try {
        record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
        conversation = cloneSessionConversation(record);
        acpxState = cloneSessionAcpxState(record.acpx);
        const promptStartedAt = isoNow();
        const promptMessageId = recordPromptSubmission(conversation, promptInput, promptStartedAt);
        trimConversationForRuntime(conversation);
        record.lastPromptAt = promptStartedAt;
        record.lastUsedAt = promptStartedAt;
        record.acpx = acpxState;
        applyConversation(record, conversation);
        await this.options.sessionStore.save(record);

        const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
        client =
          pendingClient ??
          this.createClient({
            agentCommand: record.agentCommand,
            cwd: record.cwd,
            mcpServers: [...(this.options.mcpServers ?? [])],
            permissionMode: this.options.permissionMode,
            nonInteractivePermissions: this.options.nonInteractivePermissions,
            verbose: this.options.verbose,
          });
        const runtimeClient = client;
        const runtimeConversation = conversation;
        const runtimeRecord = record;
        liveCheckpoint = new LiveSessionCheckpoint({
          save: async () => {
            runtimeRecord.lastUsedAt = isoNow();
            runtimeRecord.acpx = acpxState;
            applyConversation(runtimeRecord, runtimeConversation);
            await this.refreshClosedState(runtimeRecord);
            await this.options.sessionStore.save(runtimeRecord);
          },
        });
        let activeSessionId = record.acpSessionId;

        const applyPendingCancel = async (): Promise<boolean> => {
          if (!pendingCancel || !runtimeClient.hasActivePrompt()) {
            return false;
          }
          const cancelled = await runtimeClient.requestCancelActivePrompt();
          if (cancelled) {
            pendingCancel = false;
          }
          return cancelled;
        };

        activeController = {
          hasActivePrompt: () => runtimeClient.hasActivePrompt(),
          requestCancelActivePrompt: async () => {
            if (runtimeClient.hasActivePrompt()) {
              return await runtimeClient.requestCancelActivePrompt();
            }
            if (!turnActive) {
              return false;
            }
            pendingCancel = true;
            return true;
          },
          setSessionMode: async (modeId: string) => {
            if (!runtimeClient.hasActivePrompt()) {
              await sessionReady.promise;
            }
            await runtimeClient.setSessionMode(activeSessionId, modeId);
            const nextState = cloneSessionAcpxState(acpxState) ?? {};
            nextState.desired_mode_id = modeId;
            acpxState = nextState;
          },
          setSessionModel: async (modelId: string) => {
            if (!runtimeClient.hasActivePrompt()) {
              await sessionReady.promise;
            }
            await runtimeClient.setSessionModel(activeSessionId, modelId);
          },
          setSessionConfigOption: async (configId: string, value: string) => {
            if (!runtimeClient.hasActivePrompt()) {
              await sessionReady.promise;
            }
            const response = await runtimeClient.setSessionConfigOption(
              activeSessionId,
              configId,
              value,
            );
            if (response?.configOptions) {
              const nextState = cloneSessionAcpxState(acpxState) ?? {};
              nextState.config_options = structuredClone(response.configOptions);
              acpxState = nextState;
            }
            if (configId === "mode") {
              const nextState = cloneSessionAcpxState(acpxState) ?? {};
              nextState.desired_mode_id = value;
              acpxState = nextState;
            } else if (configId !== "model") {
              const nextState = cloneSessionAcpxState(acpxState) ?? {};
              nextState.desired_config_options = {
                ...nextState.desired_config_options,
                [configId]: value,
              };
              acpxState = nextState;
            }
            return response;
          },
        };

        const emitParsed = (payload: Record<string, unknown>): void => {
          if (streamClosed) {
            return;
          }
          const parsed = parsePromptEventLine(JSON.stringify(payload));
          if (!parsed) {
            return;
          }
          queue.push(parsed);
        };

        this.activeControllers.set(runtimeRecord.acpxRecordId, activeController);
        runtimeClient.setEventHandlers({
          onSessionUpdate: (notification) => {
            acpxState = recordSessionUpdate(runtimeConversation, acpxState, notification);
            trimConversationForRuntime(runtimeConversation);
            liveCheckpoint?.request();
            emitParsed({
              jsonrpc: "2.0",
              method: "session/update",
              params: notification,
            });
          },
          onClientOperation: (operation: ClientOperation) => {
            acpxState = recordClientOperation(runtimeConversation, acpxState, operation);
            trimConversationForRuntime(runtimeConversation);
            liveCheckpoint?.request();
            emitParsed({
              type: "client_operation",
              ...operation,
            });
          },
        });

        const { sessionId, resumed, loadError } = pendingClient
          ? {
              sessionId: record.acpSessionId,
              resumed: false,
              loadError: undefined,
            }
          : await connectAndLoadSession({
              client: runtimeClient,
              record: runtimeRecord,
              resumePolicy: resumePolicyForSessionMode(input.sessionMode),
              timeoutMs: this.options.timeoutMs,
              activeController,
              onClientAvailable: (controller) => {
                activeController = controller;
                this.activeControllers.set(runtimeRecord.acpxRecordId, controller);
              },
              onConnectedRecord: (connectedRecord) => {
                connectedRecord.lastPromptAt = isoNow();
              },
              onSessionIdResolved: (sessionIdValue) => {
                activeSessionId = sessionIdValue;
              },
            });
        sessionReady.resolve();
        runtimeRecord.lastRequestId = input.requestId;
        runtimeRecord.lastPromptAt = isoNow();
        runtimeRecord.closed = false;
        runtimeRecord.closedAt = undefined;
        runtimeRecord.lastUsedAt = isoNow();
        await liveCheckpoint.checkpoint();
        if (resumed || loadError) {
          emitParsed({
            type: "status",
            text: loadError ? `load fallback: ${loadError}` : "session resumed",
          });
        }

        if (pendingCancel || input.signal?.aborted) {
          pendingCancel = false;
          settleResult({
            status: "cancelled",
            stopReason: "cancelled",
          });
          return;
        }

        await applyPendingCancel();
        const response = await runPromptTurn({
          client: runtimeClient,
          sessionId,
          prompt: promptInput,
          timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
          conversation: runtimeConversation,
          promptMessageId,
        });

        runtimeRecord.acpSessionId = activeSessionId;
        reconcileAgentSessionId(runtimeRecord, runtimeRecord.agentSessionId);
        runtimeRecord.protocolVersion = runtimeClient.initializeResult?.protocolVersion;
        runtimeRecord.agentCapabilities = runtimeClient.initializeResult?.agentCapabilities;
        runtimeRecord.acpx = acpxState;
        applyConversation(runtimeRecord, runtimeConversation);
        applyLifecycleSnapshotToRecord(runtimeRecord, runtimeClient.getAgentLifecycleSnapshot());
        await this.options.sessionStore.save(runtimeRecord);

        settleResult({
          status: response.stopReason === "cancelled" ? "cancelled" : "completed",
          ...(response.stopReason ? { stopReason: response.stopReason } : {}),
        });
      } catch (error) {
        sessionReady.reject(error);
        const normalized = normalizeOutputError(error, { origin: "runtime" });
        settleResult({
          status: "failed",
          error: {
            message: normalized.message,
            ...(normalized.code ? { code: normalized.code } : {}),
            ...(normalized.detailCode ? { detailCode: normalized.detailCode } : {}),
            ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
          },
        });
      } finally {
        turnActive = false;
        if (input.signal) {
          input.signal.removeEventListener("abort", abortHandler);
        }
        client?.clearEventHandlers();
        let pooled = false;
        if (record && conversation) {
          applyLifecycleSnapshotToRecord(
            record,
            client?.getAgentLifecycleSnapshot() ?? { running: false },
          );
          record.acpx = acpxState;
          applyConversation(record, conversation);
          record.lastUsedAt = isoNow();
          await liveCheckpoint?.flush().catch(() => {});
          const closed = await this.refreshClosedState(record);
          await this.options.sessionStore.save(record).catch(() => {});
          if (!closed && client) {
            pooled = await this.retainPersistentClientAfterTurn({ record, client });
          }
        }
        if (!pooled) {
          await client?.close().catch(() => {});
        }
        if (record) {
          this.activeControllers.delete(record.acpxRecordId);
          this.closingActiveRecords.delete(record.acpxRecordId);
        }
        queue.close();
      }
    })();

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
    let targetRecord = record;
    if (controller) {
      const response = await controller.setSessionConfigOption(key, value);
      applyConfigOptionsToRecord(targetRecord, response);
    } else {
      const result = await this.withRuntimeControlSession(
        record,
        sessionMode,
        async ({ client, sessionId, record: connectedRecord }) => {
          const response = await client.setSessionConfigOption(sessionId, key, value);
          applyConfigOptionsToRecord(connectedRecord, response);
          if (key === "mode") {
            setDesiredModeId(connectedRecord, value);
          } else {
            setDesiredConfigOption(connectedRecord, key, value);
          }
        },
      );
      targetRecord = result.record;
    }
    if (key === "mode") {
      setDesiredModeId(targetRecord, value);
    } else {
      setDesiredConfigOption(targetRecord, key, value);
    }
    await this.options.sessionStore.save(targetRecord);
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
