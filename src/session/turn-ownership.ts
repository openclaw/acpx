import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { incrementPerfCounter } from "../perf-metrics.js";
import { sessionBaseDir, sessionEventLockPath } from "./event-log.js";
import { createLockOwner, lockOwnerPid, type LockOwner } from "./lock-owner.js";

const LOCK_RETRY_MS = 15;
const INCOMPLETE_RESERVATION_GRACE_MS = 15_000;
let lastCreatedAt = 0;

type LockSnapshot = { stat: BigIntStats; payload: string };

type TurnCleanup = {
  owner: LockOwner;
  guard?: FileLockHandle;
  removeMarker?: () => Promise<unknown>;
  admitted: boolean;
  failed: boolean;
  settled: boolean;
  pending?: Promise<boolean>;
};

// Retain failed receipts by canonical path. Active turns and in-flight cleanup
// stay registered too, so another acquisition cannot settle or replace them.
const localTurns = new Map<string, TurnCleanup>();

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

function parseLock(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

async function tryAcquireGuard(
  filePath: string,
  owner: LockOwner,
  signal?: AbortSignal,
): Promise<FileLockHandle | undefined> {
  try {
    return await acquireFileLock(filePath, {
      managerKey: "acpx.session-turn",
      lockPath: `${filePath}.guard`,
      staleMs: Infinity,
      timeoutMs: LOCK_RETRY_MS,
      retry: { retries: 8, minTimeout: 1, maxTimeout: 2, factor: 1, randomize: false },
      staleRecovery: "remove-if-unchanged",
      payload: () => owner.payload,
      shouldReclaim: ({ payload }) => owner.hasExited(payload, false, signal),
      shouldRemoveStaleLock: ({ payload }) => owner.hasExited(payload, true, signal),
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

async function recoverAbandonedLock(
  filePath: string,
  owner: LockOwner,
  signal?: AbortSignal,
): Promise<boolean> {
  const observed = await readLock(filePath);
  if (!observed) {
    return true;
  }
  const payload = parseLock(observed.payload);
  const pid = lockOwnerPid(payload);
  // Cached custody can delay recovery; removing a marker needs a fresh confirmation.
  if (
    pid &&
    (!(await owner.hasExited(payload, false, signal)) ||
      !(await owner.hasExited(payload, true, signal)))
  ) {
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
  receipt: TurnCleanup,
  error: unknown,
): Promise<never> {
  const failures = [error];
  await disposeTurn(filePath, receipt).catch((cleanupError: unknown) => {
    failures.push(
      ...(cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]),
    );
  });
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session turn acquisition and cleanup failed");
  }
  throw error;
}

async function releaseTurnGuard(receipt: TurnCleanup): Promise<void> {
  await receipt.guard?.release();
  receipt.guard = undefined;
}

async function removeTurnMarker(filePath: string, receipt: TurnCleanup): Promise<boolean> {
  if (!receipt.removeMarker) {
    return true;
  }
  // Failed admission may already have released its guard. Re-establish
  // exclusion before replaying marker cleanup, including uncertain releases.
  if (receipt.guard && !(await receipt.guard.verifyStillHeld())) {
    await releaseTurnGuard(receipt);
  }
  // A canceled admission must not poison a later cleanup attempt with its signal.
  receipt.guard ??= await tryAcquireGuard(filePath, receipt.owner);
  if (!receipt.guard) {
    return false;
  }
  await receipt.removeMarker();
  receipt.removeMarker = undefined;
  return true;
}

async function settleTurn(filePath: string, receipt: TurnCleanup): Promise<boolean> {
  if (receipt.settled) {
    return true;
  }
  const pending = (receipt.pending ??= (async () => {
    receipt.failed = false;
    const failures: unknown[] = [];
    try {
      if (!(await removeTurnMarker(filePath, receipt))) {
        return false;
      }
    } catch (error) {
      failures.push(error);
    }
    // Unadmitted cleanup still releases exclusion when marker removal fails.
    // An admitted turn keeps its guard until all marker mutations have finished.
    if (failures.length === 0 || !receipt.admitted) {
      try {
        await releaseTurnGuard(receipt);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Session turn cleanup failed");
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    receipt.settled = true;
    localTurns.delete(filePath);
    return true;
  })());
  try {
    return await pending;
  } finally {
    if (receipt.pending === pending) {
      receipt.pending = undefined;
      receipt.failed = !receipt.settled;
    }
  }
}

async function disposeTurn(filePath: string, receipt: TurnCleanup): Promise<void> {
  if (!(await settleTurn(filePath, receipt))) {
    throw new Error(`Session turn cleanup is waiting for its guard: ${filePath}`);
  }
}

async function tryPublishLock(
  filePath: string,
  payload: string,
  owner: LockOwner,
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
      if (!(await recoverAbandonedLock(filePath, owner, signal))) {
        return false;
      }
    }
  }
}

async function tryAcquireTurnCleanup(
  filePath: string,
  payload: string,
  owner: LockOwner,
  signal?: AbortSignal,
): Promise<TurnCleanup | undefined> {
  const previous = localTurns.get(filePath);
  if (previous) {
    if (previous.failed) {
      await settleTurn(filePath, previous);
    }
    return undefined;
  }
  const receipt: TurnCleanup = {
    owner,
    removeMarker: async () => await removePublishedLock(filePath, payload),
    admitted: false,
    failed: false,
    settled: false,
  };
  localTurns.set(filePath, receipt);
  try {
    receipt.guard = await tryAcquireGuard(filePath, owner, signal);
  } catch (error) {
    localTurns.delete(filePath);
    throw error;
  }
  if (!receipt.guard) {
    localTurns.delete(filePath);
    return undefined;
  }
  return receipt;
}

async function tryAcquireTurn(
  filePath: string,
  payload: string,
  owner: LockOwner,
  signal?: AbortSignal,
): Promise<AsyncDisposable | undefined> {
  const receipt = await tryAcquireTurnCleanup(filePath, payload, owner, signal);
  if (!receipt) {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    if (!(await tryPublishLock(filePath, payload, owner, signal))) {
      await disposeTurn(filePath, receipt);
      return undefined;
    }
    const observed = await readLock(filePath);
    if (observed?.payload !== payload) {
      throw new Error(`Session turn ownership changed before admission: ${filePath}`);
    }
    signal?.throwIfAborted();
    receipt.admitted = true;
    receipt.removeMarker = async () => await removeObservedLock(filePath, observed);
    return { [Symbol.asyncDispose]: async () => await disposeTurn(filePath, receipt) };
  } catch (error) {
    return await rejectAcquisition(filePath, receipt, error);
  }
}

export async function acquireSessionTurn(
  recordId: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  return await acquireSessionOwnership(sessionEventLockPath(recordId), signal);
}

// Keep the established ensure marker so imports also coordinate with older ensures.
// Callers supply the same resolved cwd and normalized name used by discovery.
export async function acquireSessionScope(
  scope: { agentCommand: string; cwd: string; name?: string },
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  const key = createHash("sha256")
    .update(JSON.stringify([scope.agentCommand, scope.cwd, scope.name]))
    .digest("hex");
  return await acquireSessionTurn(`ensure:${key}`, signal);
}

export async function acquireSessionImport(signal?: AbortSignal): Promise<AsyncDisposable> {
  return await acquireSessionOwnership(
    path.join(sessionBaseDir(), ".import-admission.lock"),
    signal,
  );
}

async function acquireSessionOwnership(
  requestedPath: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  await fs.mkdir(path.dirname(requestedPath), { recursive: true, mode: 0o700 });
  const filePath = path.join(
    await fs.realpath(path.dirname(requestedPath)),
    path.basename(requestedPath),
  );
  const owner = await createLockOwner({ signal });
  // Publish the same birth in the marker and guard; either can survive a crash.
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  const payload = `${JSON.stringify({ ...owner.payload, created_at: new Date(lastCreatedAt).toISOString() }, null, 2)}\n`;
  for (;;) {
    signal?.throwIfAborted();
    const turn = await tryAcquireTurn(filePath, payload, owner, signal);
    if (turn) {
      return turn;
    }
    await delay(LOCK_RETRY_MS, undefined, { signal });
  }
}
