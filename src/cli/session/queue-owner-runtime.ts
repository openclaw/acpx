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
import type {
  QueueOwnerProcessExitState,
  QueueOwnerRuntimeOptions,
} from "./queue-owner-process.js";
import {
  formatQueueOwnerStartupFailure,
  queueOwnerRuntimeOptionsFromSend,
  spawnQueueOwnerProcess,
} from "./queue-owner-process.js";
import { runQueuedTask } from "./runtime.js";

const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
const QUEUE_OWNER_ACTIVE_TURN_CANCEL_GRACE_MS = 750;

async function submitToRunningOwner(
  options: SessionSendOptions,
  waitForCompletion: boolean,
  extras?: { onQueueAccepted?: () => void },
): Promise<SessionSendOutcome | undefined> {
  return await trySubmitToRunningOwner({
    sessionId: options.sessionId,
    message: promptToDisplayText(options.prompt),
    prompt: options.prompt,
    mcpConfigPath: options.mcpConfigPath,
    mcpConfigFingerprint: options.mcpConfigFingerprint,
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
    onQueueAccepted: extras?.onQueueAccepted,
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

function queueOwnerExitIsFatal(exit: QueueOwnerProcessExitState): boolean {
  return exit.exited && (exit.spawnError !== undefined || exit.code !== 0 || exit.signal !== null);
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
  // Kill the bridge before draining IPC so it cannot outlive the owner.
  await params.sharedClient.close().catch(() => {
    // best effort while queue owner is shutting down
  });
  await params.owner?.close();
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

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type QueueOwnerShutdownController = {
  readonly requested: boolean;
  request: () => void;
  setActiveTurn: (turn: Promise<void>) => void;
  clearActiveTurn: (turn: Promise<void>) => void;
  shutdown: () => Promise<void>;
};

function createQueueOwnerShutdownController(params: {
  lease: QueueOwnerLease;
  getOwner: () => SessionQueueOwner | undefined;
  stopHeartbeat: () => void;
  turnController: QueueOwnerTurnController;
  sharedClient: AcpClient;
  sessionId: string;
  verbose?: boolean;
}): QueueOwnerShutdownController {
  let requested = false;
  let activeTurn: Promise<void> | undefined;
  let activeTurnShutdown: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const drainActiveTurn = async (): Promise<void> => {
    const turn = activeTurn;
    if (!turn) {
      return;
    }

    void params.turnController.requestCancel().catch((error) => {
      logDeferredCancelFailure(error, params.verbose);
    });

    if (!(await settlesWithin(turn, QUEUE_OWNER_ACTIVE_TURN_CANCEL_GRACE_MS))) {
      // A bridge that ignores session/cancel must still be terminated before
      // the external queue-owner SIGKILL deadline. Closing it forces the active
      // turn to unwind; the lease remains held until that unwind completes.
      await params.sharedClient.close().catch(() => {
        // best effort while forcing active-turn cancellation
      });
    }
    await turn.catch(() => {
      // The main loop preserves the original turn result; shutdown only waits
      // for its cleanup boundary before releasing the lease.
    });
  };

  const request = (): void => {
    requested = true;
    params.stopHeartbeat();
    params.getOwner()?.beginShutdown();
    activeTurnShutdown ??= drainActiveTurn();
  };

  return {
    get requested() {
      return requested;
    },
    request,
    setActiveTurn: (turn) => {
      activeTurn = turn;
    },
    clearActiveTurn: (turn) => {
      if (activeTurn === turn) {
        activeTurn = undefined;
      }
    },
    shutdown: () => {
      request();
      shutdownPromise ??= (async () => {
        await activeTurnShutdown;
        await closeQueueOwnerRuntime({
          lease: params.lease,
          owner: params.getOwner(),
          heartbeatTimer: undefined,
          turnController: params.turnController,
          sharedClient: params.sharedClient,
          sessionId: params.sessionId,
          verbose: params.verbose,
        });
      })();
      return shutdownPromise;
    },
  };
}

function applyRequestedShutdown(
  owner: SessionQueueOwner,
  shutdown: QueueOwnerShutdownController,
): void {
  if (shutdown.requested) {
    owner.beginShutdown();
  }
}

function startQueueOwnerHeartbeat(params: {
  enabled: boolean;
  lease: QueueOwnerLease;
  owner: SessionQueueOwner;
}): NodeJS.Timeout | undefined {
  if (!params.enabled) {
    return undefined;
  }
  return setInterval(() => {
    void refreshQueueOwnerLease(params.lease, { queueDepth: params.owner.queueDepth() }).catch(
      () => {
        // best effort heartbeat refresh while owner is live
      },
    );
  }, QUEUE_OWNER_HEARTBEAT_INTERVAL_MS);
}

export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId, {
    path: options.mcpConfigPath,
    fingerprint: options.mcpConfigFingerprint,
  });
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

  const shutdown = createQueueOwnerShutdownController({
    lease,
    getOwner: () => owner,
    stopHeartbeat: () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    },
    turnController,
    sharedClient,
    sessionId: options.sessionId,
    verbose: options.verbose,
  });

  const onSignal = (): void => {
    shutdown.request();
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

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

    applyRequestedShutdown(owner, shutdown);

    logQueueOwnerReady({
      sessionId: options.sessionId,
      ttlMs,
      maxQueueDepth,
      verbose: options.verbose,
    });
    await refreshQueueOwnerLease(lease, { queueDepth: owner.queueDepth() }).catch(() => {
      // best effort initial heartbeat
    });
    heartbeatTimer = startQueueOwnerHeartbeat({
      enabled: !shutdown.requested,
      lease,
      owner,
    });
    let isFirstTask = true;
    while (true) {
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : taskPollTimeoutMs;
      const task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        break;
      }
      isFirstTask = false;

      const turnPromise = runPromptTurn(async () => {
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
            handleProcessInterrupts: false,
          });
        } finally {
          checkpointPerfMetricsCapture();
        }
      });
      shutdown.setActiveTurn(turnPromise);
      try {
        await turnPromise;
      } finally {
        shutdown.clearActiveTurn(turnPromise);
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    await shutdown.shutdown();
  }
}

export async function sendSession(options: SessionSendOptions): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;

  const queuedToOwner = await submitToRunningOwner(options, waitForCompletion);
  if (queuedToOwner) {
    return queuedToOwner;
  }

  const owner = spawnQueueOwnerProcess(queueOwnerRuntimeOptionsFromSend(options));
  // Stop retaining diagnostics at first IPC accept (not after full turn completion).
  const onQueueAccepted = () => {
    owner.stopStartupCapture();
  };

  for (let attempt = 0; attempt < QUEUE_OWNER_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    const queued = await submitToRunningOwner(options, waitForCompletion, { onQueueAccepted });
    if (queued) {
      // Accept already stopped capture via onQueueAccepted; call again is idempotent.
      owner.stopStartupCapture();
      return queued;
    }
    const exit = owner.getExitState();
    if (queueOwnerExitIsFatal(exit)) {
      const message = formatQueueOwnerStartupFailure({
        sessionId: options.sessionId,
        exit,
        logTail: owner.readLogTail(),
      });
      owner.stopStartupCapture();
      throw new Error(message);
    }
    await waitMs(QUEUE_CONNECT_RETRY_MS);
  }

  const finalExit = owner.getExitState();
  const message = formatQueueOwnerStartupFailure({
    sessionId: options.sessionId,
    exit: finalExit.exited ? finalExit : { exited: false, code: null, signal: null },
    logTail: owner.readLogTail(),
  });
  owner.stopStartupCapture();
  throw new Error(message);
}

export type { QueueOwnerRuntimeOptions };
export { DEFAULT_QUEUE_OWNER_TTL_MS };
export const queueOwnerRuntimeTestInternals = { queueOwnerExitIsFatal };
