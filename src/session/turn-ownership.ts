import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { incrementPerfCounter } from "../perf-metrics.js";
import { isProcessDefinitelyDead } from "../process-liveness.js";
import { sessionEventLockPath } from "./event-log.js";

const LOCK_RETRY_MS = 15;
const INCOMPLETE_RESERVATION_GRACE_MS = 15_000;
let lastCreatedAt = 0;

type LockSnapshot = { stat: BigIntStats; payload: string };

async function readLock(filePath: string): Promise<LockSnapshot | undefined> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile()) {
      throw new Error(`Session turn lock is not a regular file: ${filePath}`);
    }
    return { stat, payload: await fs.readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function lockPid(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("pid" in value)) {
    return undefined;
  }
  const pid = value.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function parseLock(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

async function tryAcquireGuard(filePath: string): Promise<FileLockHandle | undefined> {
  try {
    return await acquireFileLock(filePath, {
      managerKey: "acpx.session-turn",
      lockPath: `${filePath}.guard`,
      staleMs: Infinity,
      timeoutMs: LOCK_RETRY_MS,
      retry: { retries: 8, minTimeout: 1, maxTimeout: 2, factor: 1, randomize: false },
      staleRecovery: "remove-if-unchanged",
      payload: () => ({ pid: process.pid }),
      shouldReclaim: ({ payload }) => isProcessDefinitelyDead(lockPid(payload)),
      shouldRemoveStaleLock: ({ payload }) => isProcessDefinitelyDead(lockPid(payload)),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "file_lock_timeout") {
      return undefined;
    }
    throw error;
  }
}

async function removeObservedLock(filePath: string, observed: LockSnapshot): Promise<boolean> {
  const current = await readLock(filePath);
  if (!current) {
    return true;
  }
  if (
    current.payload !== observed.payload ||
    current.stat.mtimeNs !== observed.stat.mtimeNs ||
    current.stat.size !== observed.stat.size
  ) {
    return false;
  }
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  return true;
}

async function recoverAbandonedLock(filePath: string): Promise<boolean> {
  const observed = await readLock(filePath);
  if (!observed) {
    return true;
  }
  const pid = lockPid(parseLock(observed.payload));
  if (pid && !isProcessDefinitelyDead(pid)) {
    return false;
  }
  // A partial exclusive-create fallback is not evidence that its writer died.
  if (!pid && Date.now() - Number(observed.stat.mtimeMs) <= INCOMPLETE_RESERVATION_GRACE_MS) {
    return false;
  }
  if (await removeObservedLock(filePath, observed)) {
    incrementPerfCounter("session.events.stale_lock_recovered");
    return true;
  }
  return false;
}

async function publishLock(filePath: string, payload: string, signal?: AbortSignal): Promise<void> {
  await withTempFile(
    { rootDir: path.dirname(filePath), prefix: "session-turn", fileName: "lock" },
    async (temporaryPath) => {
      await fs.writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if (!isHardlinkFallbackError(error)) {
          throw error;
        }
        await fs.writeFile(filePath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
    },
  );
}

async function removePublishedLock(filePath: string, payload: string): Promise<void> {
  const current = await readLock(filePath);
  if (current?.payload === payload) {
    await removeObservedLock(filePath, current);
  }
}

async function rejectAcquisition(
  filePath: string,
  payload: string,
  guard: FileLockHandle,
  error: unknown,
): Promise<never> {
  const failures = [error];
  await removePublishedLock(filePath, payload).catch((cleanupError: unknown) => {
    failures.push(cleanupError);
  });
  // No admitted turn or pending marker mutation remains, even if cleanup failed.
  await guard.release().catch((releaseError: unknown) => {
    failures.push(releaseError);
  });
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session turn acquisition and cleanup failed");
  }
  throw error;
}

function turnReceipt(
  filePath: string,
  observed: LockSnapshot,
  guard: FileLockHandle,
): AsyncDisposable {
  let disposed = false;
  let disposal: Promise<void> | undefined;
  return {
    [Symbol.asyncDispose]: async () => {
      if (disposed) {
        return;
      }
      const pending = (disposal ??= (async () => {
        await removeObservedLock(filePath, observed);
        await guard.release();
        disposed = true;
      })());
      try {
        await pending;
      } finally {
        if (disposal === pending) {
          disposal = undefined;
        }
      }
    },
  };
}

async function tryPublishLock(
  filePath: string,
  payload: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    try {
      await publishLock(filePath, payload, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (!(await recoverAbandonedLock(filePath))) {
        return false;
      }
    }
  }
}

async function tryAcquireTurn(
  filePath: string,
  payload: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable | undefined> {
  const guard = await tryAcquireGuard(filePath);
  if (!guard) {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    if (!(await tryPublishLock(filePath, payload, signal))) {
      await guard.release();
      return undefined;
    }
    const observed = await readLock(filePath);
    if (observed?.payload !== payload) {
      throw new Error(`Session turn ownership changed before admission: ${filePath}`);
    }
    signal?.throwIfAborted();
    return turnReceipt(filePath, observed, guard);
  } catch (error) {
    return await rejectAcquisition(filePath, payload, guard, error);
  }
}

export async function acquireSessionTurn(
  recordId: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  const requestedPath = sessionEventLockPath(recordId);
  await fs.mkdir(path.dirname(requestedPath), { recursive: true, mode: 0o700 });
  const filePath = path.join(
    await fs.realpath(path.dirname(requestedPath)),
    path.basename(requestedPath),
  );
  // Keep the legacy marker bytes; the guard serializes every marker mutation through disposal.
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  const payload = `${JSON.stringify({ pid: process.pid, created_at: new Date(lastCreatedAt).toISOString() }, null, 2)}\n`;
  for (;;) {
    signal?.throwIfAborted();
    const turn = await tryAcquireTurn(filePath, payload, signal);
    if (turn) {
      return turn;
    }
    await delay(LOCK_RETRY_MS, undefined, { signal });
  }
}
