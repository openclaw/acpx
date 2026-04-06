import { randomUUID } from "node:crypto";
import path from "node:path";
import { AcpClient } from "../../acp/client.js";
import { normalizeOutputError } from "../../acp/error-normalization.js";
import { textPrompt, type PromptInput } from "../../prompt-content.js";
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
import { setDesiredModeId } from "../../session/mode-preference.js";
import type { ClientOperation, SessionRecord, SessionResumePolicy } from "../../types.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimePromptMode,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
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

export class AcpRuntimeManager {
  private readonly activeControllers = new Map<string, ActiveSessionController>();
  private readonly pendingPersistentClients = new Map<string, AcpClient>();

  constructor(
    private readonly options: AcpRuntimeOptions,
    private readonly deps: AcpRuntimeManagerDeps = {},
  ) {}

  private createClient(options: ConstructorParameters<typeof AcpClient>[0]): AcpClient {
    return this.deps.clientFactory?.(options) ?? new AcpClient(options);
  }

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
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
      existing.closed = false;
      existing.closedAt = undefined;
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
    });
    let keepClientOpen = false;

    try {
      await client.start();
      let sessionId: string;
      let agentSessionId: string | undefined;
      if (input.resumeSessionId) {
        const loaded = await client.loadSession(input.resumeSessionId, cwd);
        sessionId = input.resumeSessionId;
        agentSessionId = loaded.agentSessionId;
      } else {
        const created = await client.createSession(cwd);
        sessionId = created.sessionId;
        agentSessionId = created.agentSessionId;
      }
      const record = createInitialRecord({
        recordId: createRecordId(input.sessionKey, input.mode),
        sessionName: input.sessionKey,
        sessionId,
        agentCommand,
        cwd,
        agentSessionId,
      });
      record.protocolVersion = client.initializeResult?.protocolVersion;
      record.agentCapabilities = client.initializeResult?.agentCapabilities;
      applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
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
    const record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
    const conversation = cloneSessionConversation(record);
    let acpxState = cloneSessionAcpxState(record.acpx);
    const promptInput = toPromptInput(input.text, input.attachments);
    const promptMessageId = recordPromptSubmission(conversation, promptInput, isoNow());
    trimConversationForRuntime(conversation);

    const queue = new AsyncEventQueue();
    let pendingClient = this.pendingPersistentClients.get(record.acpxRecordId);
    if (pendingClient) {
      this.pendingPersistentClients.delete(record.acpxRecordId);
      if (!pendingClient.hasReusableSession(record.acpSessionId)) {
        await pendingClient.close().catch(() => {});
        pendingClient = undefined;
      }
    }
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
    let activeSessionId = record.acpSessionId;
    let sawDone = false;
    let pendingCancel = false;
    let turnActive = true;
    const sessionReady = createDeferred<void>();
    void sessionReady.promise.catch(() => {});

    const applyPendingCancel = async (): Promise<boolean> => {
      if (!pendingCancel || !client.hasActivePrompt()) {
        return false;
      }
      const cancelled = await client.requestCancelActivePrompt();
      if (cancelled) {
        pendingCancel = false;
      }
      return cancelled;
    };

    const activeController: ActiveSessionController = {
      hasActivePrompt: () => client.hasActivePrompt(),
      requestCancelActivePrompt: async () => {
        if (client.hasActivePrompt()) {
          return await client.requestCancelActivePrompt();
        }
        if (!turnActive) {
          return false;
        }
        pendingCancel = true;
        return true;
      },
      setSessionMode: async (modeId: string) => {
        if (!client.hasActivePrompt()) {
          await sessionReady.promise;
        }
        await client.setSessionMode(activeSessionId, modeId);
      },
      setSessionModel: async (modelId: string) => {
        if (!client.hasActivePrompt()) {
          await sessionReady.promise;
        }
        await client.setSessionModel(activeSessionId, modelId);
      },
      setSessionConfigOption: async (configId: string, value: string) => {
        if (!client.hasActivePrompt()) {
          await sessionReady.promise;
        }
        return await client.setSessionConfigOption(activeSessionId, configId, value);
      },
    };

    const emitParsed = (payload: Record<string, unknown>): void => {
      const parsed = parsePromptEventLine(JSON.stringify(payload));
      if (!parsed) {
        return;
      }
      if (parsed.type === "done") {
        sawDone = true;
      }
      queue.push(parsed);
    };

    const abortHandler = () => {
      void activeController.requestCancelActivePrompt();
    };
    if (input.signal) {
      if (input.signal.aborted) {
        queue.close();
        return;
      }
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }

    this.activeControllers.set(record.acpxRecordId, activeController);

    void (async () => {
      try {
        client.setEventHandlers({
          onSessionUpdate: (notification) => {
            acpxState = recordSessionUpdate(conversation, acpxState, notification);
            trimConversationForRuntime(conversation);
            emitParsed({
              jsonrpc: "2.0",
              method: "session/update",
              params: notification,
            });
          },
          onClientOperation: (operation: ClientOperation) => {
            acpxState = recordClientOperation(conversation, acpxState, operation);
            trimConversationForRuntime(conversation);
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
              client,
              record,
              resumePolicy: resumePolicyForSessionMode(input.sessionMode),
              timeoutMs: this.options.timeoutMs,
              activeController,
              onClientAvailable: (controller) => {
                this.activeControllers.set(record.acpxRecordId, controller);
              },
              onConnectedRecord: (connectedRecord) => {
                connectedRecord.lastPromptAt = isoNow();
              },
              onSessionIdResolved: (sessionIdValue) => {
                activeSessionId = sessionIdValue;
              },
            });
        sessionReady.resolve();

        record.lastRequestId = input.requestId;
        record.lastPromptAt = isoNow();
        record.closed = false;
        record.closedAt = undefined;
        record.lastUsedAt = isoNow();
        if (resumed || loadError) {
          emitParsed({
            type: "status",
            text: loadError ? `load fallback: ${loadError}` : "session resumed",
          });
        }

        if (pendingCancel || input.signal?.aborted) {
          pendingCancel = false;
          if (!sawDone) {
            queue.push({
              type: "done",
              stopReason: "cancelled",
            });
          }
          return;
        }

        await applyPendingCancel();
        const response = await runPromptTurn({
          client,
          sessionId,
          prompt: promptInput,
          timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
          conversation,
          promptMessageId,
        });

        record.acpSessionId = activeSessionId;
        reconcileAgentSessionId(record, record.agentSessionId);
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        record.acpx = acpxState;
        applyConversation(record, conversation);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await this.options.sessionStore.save(record);

        if (!sawDone) {
          queue.push({
            type: "done",
            stopReason: response.stopReason,
          });
        }
      } catch (error) {
        sessionReady.reject(error);
        const normalized = normalizeOutputError(error, { origin: "runtime" });
        queue.push({
          type: "error",
          message: normalized.message,
          code: normalized.code,
          retryable: normalized.retryable,
        });
      } finally {
        turnActive = false;
        if (input.signal) {
          input.signal.removeEventListener("abort", abortHandler);
        }
        this.activeControllers.delete(record.acpxRecordId);
        client.clearEventHandlers();
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.acpx = acpxState;
        applyConversation(record, conversation);
        record.lastUsedAt = isoNow();
        await this.options.sessionStore.save(record).catch(() => {});
        await client.close().catch(() => {});
        queue.close();
      }
    })();

    yield* queue.iterate();
  }

  async getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    return {
      summary: statusSummary(record),
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      details: {
        cwd: record.cwd,
        lastUsedAt: record.lastUsedAt,
        closed: record.closed === true,
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
      const result = await withConnectedSession({
        sessionRecordId: record.acpxRecordId,
        loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
        saveRecord: async (connectedRecord) =>
          await this.options.sessionStore.save(connectedRecord),
        createClient: (options) => this.createClient(options),
        mcpServers: [...(this.options.mcpServers ?? [])],
        permissionMode: this.options.permissionMode,
        nonInteractivePermissions: this.options.nonInteractivePermissions,
        verbose: this.options.verbose,
        timeoutMs: this.options.timeoutMs,
        resumePolicy: resumePolicyForSessionMode(sessionMode),
        run: async ({ client, sessionId }) => {
          await client.setSessionMode(sessionId, mode);
        },
      });
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
      await controller.setSessionConfigOption(key, value);
    } else {
      const result = await withConnectedSession({
        sessionRecordId: record.acpxRecordId,
        loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
        saveRecord: async (connectedRecord) =>
          await this.options.sessionStore.save(connectedRecord),
        createClient: (options) => this.createClient(options),
        mcpServers: [...(this.options.mcpServers ?? [])],
        permissionMode: this.options.permissionMode,
        nonInteractivePermissions: this.options.nonInteractivePermissions,
        verbose: this.options.verbose,
        timeoutMs: this.options.timeoutMs,
        resumePolicy: resumePolicyForSessionMode(sessionMode),
        run: async ({ client, sessionId, record: connectedRecord }) => {
          await client.setSessionConfigOption(sessionId, key, value);
          if (key === "mode") {
            setDesiredModeId(connectedRecord, value);
          }
        },
      });
      targetRecord = result.record;
    }
    if (key === "mode") {
      setDesiredModeId(targetRecord, value);
    }
    await this.options.sessionStore.save(targetRecord);
  }

  async cancel(handle: AcpRuntimeHandle): Promise<void> {
    const controller = this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey);
    await controller?.requestCancelActivePrompt();
  }

  async close(handle: AcpRuntimeHandle): Promise<void> {
    const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
    await this.cancel(handle);
    record.closed = true;
    record.closedAt = isoNow();
    await this.options.sessionStore.save(record);
  }

  private async requireRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.options.sessionStore.load(sessionId);
    if (!record) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return record;
  }
}
