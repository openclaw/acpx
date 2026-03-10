import fs from "node:fs/promises";
import path from "node:path";
import { AcpClient } from "./client.js";
import { formatErrorMessage, normalizeOutputError } from "./error-normalization.js";
import { checkpointPerfMetricsCapture } from "./perf-metrics-capture.js";
import { formatPerfMetric, measurePerf, setPerfGauge, startPerfTimer } from "./perf-metrics.js";
import { refreshQueueOwnerLease } from "./queue-lease-store.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  createSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "./session-conversation-model.js";
import { defaultSessionEventLog } from "./session-event-log.js";
import { SessionEventWriter } from "./session-events.js";
import { InterruptedError, withInterrupt, withTimeout } from "./session-runtime-helpers.js";
export { InterruptedError, TimeoutError } from "./session-runtime-helpers.js";
import {
  type QueueOwnerMessage,
  type QueueTask,
  QUEUE_CONNECT_RETRY_MS,
  SessionQueueOwner,
  isProcessAlive,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  tryCancelOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
  waitMs,
} from "./queue-ipc.js";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "./queue-owner-turn-controller.js";
import { normalizeRuntimeSessionId } from "./runtime-session-id.js";
import { setDesiredModeId } from "./session-mode-preference.js";
import { connectAndLoadSession } from "./session-runtime/connect-load.js";
import { applyConversation, applyLifecycleSnapshotToRecord } from "./session-runtime/lifecycle.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModeDirect,
} from "./session-runtime/prompt-runner.js";
import {
  queueOwnerRuntimeOptionsFromSend,
  spawnQueueOwnerProcess,
  type QueueOwnerRuntimeOptions,
} from "./session-runtime/queue-owner-process.js";
export type { QueueOwnerRuntimeOptions } from "./session-runtime/queue-owner-process.js";
import { promptToDisplayText, textPrompt } from "./prompt-content.js";
import {
  DEFAULT_HISTORY_LIMIT,
  absolutePath,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isoNow,
  listSessions,
  listSessionsForAgent,
  normalizeName,
  resolveSessionRecord,
  writeSessionRecord,
} from "./session-persistence.js";
import {
  SESSION_RECORD_SCHEMA,
  type AcpJsonRpcMessage,
  type AuthPolicy,
  type McpServer,
  type NonInteractivePermissionPolicy,
  type OutputErrorEmissionPolicy,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type OutputFormatter,
  type PermissionMode,
  type PromptInput,
  type RunPromptResult,
  type SessionEnsureResult,
  type SessionRecord,
  type SessionSetConfigOptionResult,
  type SessionSetModeResult,
  type SessionSendOutcome,
  type SessionSendResult,
} from "./types.js";

export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;
const INTERRUPT_CANCEL_WAIT_MS = 2_500;
const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;

type TimedRunOptions = {
  timeoutMs?: number;
};

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
};

export type RunOnceOptions = {
  agentCommand: string;
  cwd: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
} & TimedRunOptions;

export type SessionEnsureOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  walkBoundary?: string;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
  };
}

type RunSessionPromptOptions = {
  sessionRecordId: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
  client?: AcpClient;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {
    // queue formatter context is fixed by task request id
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.send({
      type: "event",
      requestId: this.requestId,
      message,
    });
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  flush(): void {
    // no-op for stream forwarding
  }
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext(_context) {
    // no-op
  },
  onAcpMessage() {
    // no-op
  },
  onError() {
    // no-op
  },
  flush() {
    // no-op
  },
};
export function normalizeQueueOwnerTtlMs(ttlMs: number | undefined): number {
  if (ttlMs == null) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  // 0 means keep alive forever (no TTL)
  return Math.round(ttlMs);
}

async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt({
      sessionRecordId,
      mcpServers: options.mcpServers,
      prompt: task.prompt ?? textPrompt(task.message),
      permissionMode: task.permissionMode,
      nonInteractivePermissions:
        task.nonInteractivePermissions ?? options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptActive: options.onPromptActive,
      client: options.sharedClient,
    });

    if (task.waitForCompletion) {
      task.send({
        type: "result",
        requestId: task.requestId,
        result,
      });
    }
  } catch (error) {
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
    });
    const alreadyEmitted =
      (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
    if (task.waitForCompletion) {
      task.send({
        type: "error",
        requestId: task.requestId,
        code: normalizedError.code,
        detailCode: normalizedError.detailCode,
        origin: normalizedError.origin,
        message: normalizedError.message,
        retryable: normalizedError.retryable,
        acp: normalizedError.acp,
        outputAlreadyEmitted: alreadyEmitted,
      });
    }

    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });
  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  recordPromptSubmission(conversation, options.prompt, isoNow());

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  let sawAcpMessage = false;
  let eventWriterClosed = false;

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await eventWriter.close({ checkpoint });
  };

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0, pendingMessages.length);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    onAcpMessage: (_direction, message) => {
      sawAcpMessage = true;
      pendingMessages.push(message);
    },
    onAcpOutputMessage: (_direction, message) => {
      output.onAcpMessage(message);
    },
    onSessionUpdate: (notification) => {
      acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      trimConversationForRuntime(conversation);
    },
    onClientOperation: (operation) => {
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
    },
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(activeSessionIdForControl, configId, value);
    },
  };

  try {
    return await withInterrupt(
      async () => {
        const connectStartedAt = Date.now();
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await measurePerf(
          "runtime.connect_and_load",
          async () =>
            await connectAndLoadSession({
              client,
              record,
              timeoutMs: options.timeoutMs,
              verbose: options.verbose,
              activeController,
              onClientAvailable: (controller) => {
                options.onClientAvailable?.(controller);
                notifiedClientAvailable = true;
              },
              onConnectedRecord: (connectedRecord) => {
                connectedRecord.lastPromptAt = isoNow();
              },
              onSessionIdResolved: (sessionId) => {
                activeSessionIdForControl = sessionId;
              },
            }),
        );
        if (options.verbose) {
          process.stderr.write(
            `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - connectStartedAt)}\n`,
          );
        }

        output.setContext({
          sessionId: record.acpxRecordId,
        });
        await flushPendingMessages(false);

        let response;
        try {
          const promptStartedAt = Date.now();
          const promptPromise = client.prompt(activeSessionId, options.prompt);
          if (options.onPromptActive) {
            try {
              await options.onPromptActive();
            } catch (error) {
              if (options.verbose) {
                process.stderr.write(
                  "[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n",
                );
              }
            }
          }
          response = await measurePerf("runtime.prompt.agent_turn", async () => {
            return await withTimeout(promptPromise, options.timeoutMs);
          });
          if (options.verbose) {
            process.stderr.write(
              `[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - promptStartedAt)}\n`,
            );
          }
        } catch (error) {
          const snapshot = client.getAgentLifecycleSnapshot();
          applyLifecycleSnapshotToRecord(record, snapshot);
          if (snapshot.lastExit?.unexpectedDuringPrompt && options.verbose) {
            process.stderr.write(
              "[acpx] agent disconnected during prompt (" +
                snapshot.lastExit.reason +
                ", exit=" +
                snapshot.lastExit.exitCode +
                ", signal=" +
                (snapshot.lastExit.signal ?? "none") +
                ")\n",
            );
          }

          const normalizedError = normalizeOutputError(error, {
            origin: "runtime",
          });

          await flushPendingMessages(false).catch(() => {
            // best effort while bubbling prompt failure
          });

          output.flush();

          record.lastUsedAt = isoNow();
          applyConversation(record, conversation);
          record.acpx = acpxState;

          const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
          (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
          (propagated as { normalizedOutputError?: unknown }).normalizedOutputError =
            normalizedError;
          throw propagated;
        }

        await flushPendingMessages(false);
        output.flush();

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyConversation(record, conversation);
        record.acpx = acpxState;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        stopTotalTimer();

        return {
          ...toPromptResult(response.stopReason, record.acpxRecordId, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        record.acpx = acpxState;
        await flushPendingMessages(false).catch(() => {
          // best effort while process is being interrupted
        });
        if (ownClient) {
          await client.close();
        }
      },
    );
  } finally {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", stopTotalTimer())}\n`);
    } else {
      stopTotalTimer();
    }
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    client.clearEventHandlers();
    if (ownClient) {
      await client.close();
    }
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await closeEventWriter(true).catch(() => {
      // best effort on close
    });
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpOutputMessage: (_direction, message) => output.onAcpMessage(message),
    sessionOptions: options.sessionOptions,
  });

  try {
    return await withInterrupt(
      async () => {
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd)),
            options.timeoutMs,
          );
        });
        const sessionId = createdSession.sessionId;

        output.setContext({
          sessionId,
        });

        const response = await measurePerf("runtime.exec.prompt", async () => {
          return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
        });
        output.flush();
        return toPromptResult(response.stopReason, sessionId, client);
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
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
    return await withInterrupt(
      async () => {
        const cwd = absolutePath(options.cwd);
        await measurePerf("runtime.session_create.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        let sessionId: string;
        let agentSessionId: string | undefined;

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
          } catch (error) {
            throw new Error(
              `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
              {
                cause: error,
              },
            );
          }
        } else {
          const createdSession = await measurePerf(
            "runtime.session_create.create_session",
            async () => await withTimeout(client.createSession(cwd), options.timeoutMs),
          );
          sessionId = createdSession.sessionId;
          agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
        }
        const lifecycle = client.getAgentLifecycleSnapshot();

        const now = isoNow();
        const record: SessionRecord = {
          schema: SESSION_RECORD_SCHEMA,
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

        await writeSessionRecord(record);
        return record;
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

async function submitToRunningOwner(
  options: SessionSendOptions,
  waitForCompletion: boolean,
): Promise<SessionSendOutcome | undefined> {
  return await trySubmitToRunningOwner({
    sessionId: options.sessionId,
    message: promptToDisplayText(options.prompt),
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    waitForCompletion,
    verbose: options.verbose,
  });
}

export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    return;
  }

  const sessionRecord = await resolveSessionRecord(options.sessionId);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const sharedClient = new AcpClient({
    agentCommand: sessionRecord.agentCommand,
    cwd: absolutePath(sessionRecord.cwd),
    mcpServers: options.mcpServers,
    permissionMode: "approve-reads",
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  const taskPollTimeoutMs = ttlMs === 0 ? undefined : ttlMs;
  const initialTaskPollTimeoutMs =
    taskPollTimeoutMs == null ? undefined : Math.max(taskPollTimeoutMs, 1_000);
  const turnController = new QueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => await withTimeout(run(), timeoutMs),
    setSessionModeFallback: async (modeId: string, timeoutMs?: number) => {
      await runSessionSetModeDirect({
        sessionRecordId: options.sessionId,
        modeId,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        timeoutMs,
        verbose: options.verbose,
      });
    },
    setSessionConfigOptionFallback: async (configId: string, value: string, timeoutMs?: number) => {
      const result = await runSessionSetConfigOptionDirect({
        sessionRecordId: options.sessionId,
        configId,
        value,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        timeoutMs,
        verbose: options.verbose,
      });
      return result.response;
    },
  });

  const applyPendingCancel = async (): Promise<boolean> => {
    return await turnController.applyPendingCancel();
  };

  const scheduleApplyPendingCancel = (): void => {
    void applyPendingCancel().catch((error) => {
      if (options.verbose) {
        process.stderr.write(
          `[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`,
        );
      }
    });
  };

  const setActiveController = (controller: ActiveSessionController) => {
    turnController.setActiveController(controller);
    scheduleApplyPendingCancel();
  };

  const clearActiveController = () => {
    turnController.clearActiveController();
  };

  const runPromptTurn = async <T>(run: () => Promise<T>): Promise<T> => {
    turnController.beginTurn();
    try {
      return await run();
    } finally {
      turnController.endTurn();
    }
  };

  try {
    owner = await SessionQueueOwner.start(
      lease,
      {
        cancelPrompt: async () => {
          const accepted = await turnController.requestCancel();
          if (!accepted) {
            return false;
          }
          await applyPendingCancel();
          return true;
        },
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          await turnController.setSessionMode(modeId, timeoutMs);
        },
        setSessionConfigOption: async (configId: string, value: string, timeoutMs?: number) => {
          return await turnController.setSessionConfigOption(configId, value, timeoutMs);
        },
      },
      {
        maxQueueDepth,
        onQueueDepthChanged: (queueDepth) => {
          setPerfGauge("queue.owner.depth", queueDepth);
          void refreshQueueOwnerLease(lease, { queueDepth }).catch(() => {
            // best effort heartbeat refresh while owner is live
          });
        },
      },
    );

    if (options.verbose) {
      process.stderr.write(
        `[acpx] queue owner ready for session ${options.sessionId} (ttlMs=${ttlMs}, maxQueueDepth=${maxQueueDepth})\n`,
      );
    }
    await refreshQueueOwnerLease(lease, { queueDepth: owner.queueDepth() }).catch(() => {
      // best effort initial heartbeat
    });
    heartbeatTimer = setInterval(() => {
      void refreshQueueOwnerLease(lease, { queueDepth: owner?.queueDepth() ?? 0 }).catch(() => {
        // best effort heartbeat
      });
    }, QUEUE_OWNER_HEARTBEAT_INTERVAL_MS);

    let isFirstTask = true;
    while (true) {
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : taskPollTimeoutMs;
      const task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        break;
      }
      isFirstTask = false;

      await runPromptTurn(async () => {
        try {
          await runQueuedTask(options.sessionId, task, {
            sharedClient,
            verbose: options.verbose,
            mcpServers: options.mcpServers,
            nonInteractivePermissions: options.nonInteractivePermissions,
            authCredentials: options.authCredentials,
            authPolicy: options.authPolicy,
            suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
            onClientAvailable: setActiveController,
            onClientClosed: clearActiveController,
            onPromptActive: async () => {
              turnController.markPromptActive();
              await applyPendingCancel();
            },
          });
        } finally {
          checkpointPerfMetricsCapture();
        }
      });
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    turnController.beginClosing();
    if (owner) {
      await owner.close();
    }
    await sharedClient.close().catch(() => {
      // best effort while queue owner is shutting down
    });
    try {
      const record = await resolveSessionRecord(options.sessionId);
      applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
      await writeSessionRecord(record);
    } catch {
      // best effort — session may already be cleaned up
    }
    await releaseQueueOwnerLease(lease);

    if (options.verbose) {
      process.stderr.write(`[acpx] queue owner stopped for session ${options.sessionId}\n`);
    }
  }
}

export async function sendSession(options: SessionSendOptions): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;

  const queuedToOwner = await submitToRunningOwner(options, waitForCompletion);
  if (queuedToOwner) {
    return queuedToOwner;
  }

  spawnQueueOwnerProcess(queueOwnerRuntimeOptionsFromSend(options));

  for (let attempt = 0; attempt < QUEUE_OWNER_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    const queued = await submitToRunningOwner(options, waitForCompletion);
    if (queued) {
      return queued;
    }
    await waitMs(QUEUE_CONNECT_RETRY_MS);
  }

  throw new Error(`Session queue owner failed to start for session ${options.sessionId}`);
}

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    setDesiredModeId(record, options.modeId);
    await writeSessionRecord(record);
    return {
      record,
      resumed: false,
    };
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerResponse) {
    const record = await resolveSessionRecord(options.sessionId);
    if (options.configId === "mode") {
      setDesiredModeId(record, options.value);
      await writeSessionRecord(record);
    }
    return {
      record,
      response: ownerResponse,
      resumed: false,
    };
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

function firstAgentCommandToken(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const token = trimmed.split(/\s+/, 1)[0];
  return token.length > 0 ? token : undefined;
}

async function isLikelyMatchingProcess(pid: number, agentCommand: string): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const procCmdline = `/proc/${pid}/cmdline`;
  try {
    const payload = await fs.readFile(procCmdline, "utf8");
    const argv = payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (argv.length === 0) {
      return false;
    }

    const executableBase = path.basename(argv[0]);
    const expectedBase = path.basename(expectedToken);
    return (
      executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
    );
  } catch {
    // If /proc is unavailable, fall back to PID liveness checks only.
    return true;
  }
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  await terminateQueueOwnerForSession(record.acpxRecordId);

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }

  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecord(record);

  return record;
}

export {
  DEFAULT_HISTORY_LIMIT,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isProcessAlive,
  listSessions,
  listSessionsForAgent,
};
