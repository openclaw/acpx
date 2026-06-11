import { AcpClient } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { withTimeout } from "../../async-control.js";
import { checkpointPerfMetricsCapture } from "../../perf-metrics-capture.js";
import { setPerfGauge } from "../../perf-metrics.js";
import { promptToDisplayText } from "../../prompt-content.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
} from "../../runtime/engine/session-options.js";
import {
  absolutePath,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import type { SessionSendOutcome } from "../../types.js";
import {
  QUEUE_CONNECT_RETRY_MS,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySubmitToRunningOwner,
  type QueueOwnerLease,
  waitMs,
} from "../queue/ipc.js";
import { refreshQueueOwnerLease } from "../queue/lease-store.js";
import { QueueOwnerTurnController } from "../queue/owner-turn-controller.js";
import {
  DEFAULT_QUEUE_OWNER_TTL_MS,
  normalizeQueueOwnerTtlMs,
  type SessionSendOptions,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
  type ActiveSessionController,
} from "./prompt-runner.js";
import type { QueueOwnerRuntimeOptions } from "./queue-owner-process.js";
import { queueOwnerRuntimeOptionsFromSend, spawnQueueOwnerProcess } from "./queue-owner-process.js";
import { runQueuedTask } from "./runtime.js";

const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;

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
    permissionPolicy: options.permissionPolicy,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    promptRetries: options.promptRetries,
    waitForCompletion,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });
}

function createQueueOwnerSharedClient(
  options: QueueOwnerRuntimeOptions,
  sessionRecord: Awaited<ReturnType<typeof resolveSessionRecord>>,
): AcpClient {
  return new AcpClient({
    agentCommand: sessionRecord.agentCommand,
    cwd: absolutePath(sessionRecord.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    sessionOptions: mergeSessionOptions(
      options.sessionOptions,
      sessionOptionsFromRecord(sessionRecord),
    ),
  });
}

function createQueueOwnerTurnController(
  options: QueueOwnerRuntimeOptions,
): QueueOwnerTurnController {
  return new QueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => await withTimeout(run(), timeoutMs),
    setSessionModeFallback: async (modeId: string, timeoutMs?: number) => {
      await runSessionSetModeDirect({
        sessionRecordId: options.sessionId,
        modeId,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        terminal: options.terminal,
        timeoutMs,
        verbose: options.verbose,
      });
    },
    setSessionModelFallback: async (modelId: string, timeoutMs?: number) => {
      const result = await runSessionSetModelDirect({
        sessionRecordId: options.sessionId,
        modelId,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        terminal: options.terminal,
        timeoutMs,
        verbose: options.verbose,
      });
      return result.response;
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
        terminal: options.terminal,
        timeoutMs,
        verbose: options.verbose,
      });
      return result.response;
    },
  });
}

function logDeferredCancelFailure(error: unknown, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(`[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`);
}

function logQueueOwnerReady(params: {
  sessionId: string;
  ttlMs: number;
  maxQueueDepth: number;
  verbose?: boolean;
}): void {
  if (!params.verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] queue owner ready for session ${params.sessionId} (ttlMs=${params.ttlMs}, maxQueueDepth=${params.maxQueueDepth})\n`,
  );
}

async function closeQueueOwnerRuntime(params: {
  lease: QueueOwnerLease;
  owner: SessionQueueOwner | undefined;
  heartbeatTimer: NodeJS.Timeout | undefined;
  turnController: QueueOwnerTurnController;
  sharedClient: AcpClient;
  sessionId: string;
  verbose?: boolean;
}): Promise<void> {
  if (params.heartbeatTimer) {
    clearInterval(params.heartbeatTimer);
  }
  params.turnController.beginClosing();
  await params.owner?.close();
  await params.sharedClient.close().catch(() => {
    // best effort while queue owner is shutting down
  });
  await writeQueueOwnerLifecycleSnapshot(params.sessionId, params.sharedClient);
  await releaseQueueOwnerLease(params.lease);
  if (params.verbose) {
    process.stderr.write(`[acpx] queue owner stopped for session ${params.sessionId}\n`);
  }
}

async function writeQueueOwnerLifecycleSnapshot(
  sessionId: string,
  sharedClient: AcpClient,
): Promise<void> {
  try {
    const record = await resolveSessionRecord(sessionId);
    applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  } catch {
    // best effort - session may already be cleaned up
  }
}

export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    return;
  }

  const sessionRecord = await resolveSessionRecord(options.sessionId);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const sharedClient = createQueueOwnerSharedClient(options, sessionRecord);
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  const taskPollTimeoutMs = ttlMs === 0 ? undefined : ttlMs;
  const initialTaskPollTimeoutMs =
    taskPollTimeoutMs == null ? undefined : Math.max(taskPollTimeoutMs, 1_000);
  const turnController = createQueueOwnerTurnController(options);

  const applyPendingCancel = async (): Promise<boolean> => {
    return await turnController.applyPendingCancel();
  };

  const scheduleApplyPendingCancel = (): void => {
    void applyPendingCancel().catch((error) => {
      logDeferredCancelFailure(error, options.verbose);
    });
  };

  const setActiveController = (controller: ActiveSessionController) => {
    turnController.setActiveController(controller);
    scheduleApplyPendingCancel();
  };

  const clearActiveController = () => {
    turnController.clearActiveController();
  };

  const closeActiveBackendSession = async (timeoutMs?: number): Promise<boolean> => {
    const latestRecord = await resolveSessionRecord(options.sessionId);
    if (!sharedClient.supportsCloseSession()) {
      return false;
    }
    await withTimeout(sharedClient.closeSession(latestRecord.acpSessionId), timeoutMs);
    return true;
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
        closeSession: async (timeoutMs?: number) => await closeActiveBackendSession(timeoutMs),
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          await turnController.setSessionMode(modeId, timeoutMs);
        },
        setSessionModel: async (modelId: string, timeoutMs?: number) =>
          await turnController.setSessionModel(modelId, timeoutMs),
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

    logQueueOwnerReady({
      sessionId: options.sessionId,
      ttlMs,
      maxQueueDepth,
      verbose: options.verbose,
    });
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
            promptRetries: task.promptRetries ?? 0,
            sessionOptions: options.sessionOptions,
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
    await closeQueueOwnerRuntime({
      lease,
      owner,
      heartbeatTimer,
      turnController,
      sharedClient,
      sessionId: options.sessionId,
      verbose: options.verbose,
    });
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

export type { QueueOwnerRuntimeOptions };
export { DEFAULT_QUEUE_OWNER_TTL_MS };
