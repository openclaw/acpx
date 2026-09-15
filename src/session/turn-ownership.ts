import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { incrementPerfCounter } from "../perf-metrics.js";
import { isProcessAlive } from "../process-liveness.js";
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

function lockPid(payload: string): number | undefined {
  try {
    const value = JSON.parse(payload) as { pid?: unknown } | null;
    const pid = value?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
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

async function recoverAbandonedLock(filePath: string): Promise<void> {
  const observed = await readLock(filePath);
  if (!observed) {
    return;
  }
  const pid = lockPid(observed.payload);
  if (pid === process.pid || isProcessAlive(pid)) {
    return;
  }
  // A partial exclusive-create fallback is not evidence that its writer died.
  if (!pid && Date.now() - Number(observed.stat.mtimeMs) <= INCOMPLETE_RESERVATION_GRACE_MS) {
    return;
  }
  if (await removeObservedLock(filePath, observed)) {
    incrementPerfCounter("session.events.stale_lock_recovered");
  }
}

async function publishLock(filePath: string, payload: string, signal?: AbortSignal): Promise<void> {
  try {
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
  } catch (error) {
    await removePublishedLock(filePath, payload).catch(() => {});
    throw error;
  }
}

async function removePublishedLock(filePath: string, payload: string): Promise<void> {
  const current = await readLock(filePath);
  if (current?.payload === payload) {
    await removeObservedLock(filePath, current);
  }
}

async function observePublishedLock(
  filePath: string,
  payload: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  try {
    const observed = await readLock(filePath);
    if (observed?.payload !== payload) {
      throw new Error(`Session turn ownership changed before admission: ${filePath}`);
    }
    signal?.throwIfAborted();
    return {
      [Symbol.asyncDispose]: async () => {
        await removeObservedLock(filePath, observed);
      },
    };
  } catch (error) {
    await removePublishedLock(filePath, payload).catch(() => {});
    throw error;
  }
}

export async function acquireSessionTurn(
  recordId: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  const filePath = sessionEventLockPath(recordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Keep the existing on-disk fields while distinguishing successive same-process owners.
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  const payload = `${JSON.stringify({ pid: process.pid, created_at: new Date(lastCreatedAt).toISOString() }, null, 2)}\n`;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await publishLock(filePath, payload, signal);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await recoverAbandonedLock(filePath);
      await delay(LOCK_RETRY_MS, undefined, { signal });
    }
  }
  return await observePublishedLock(filePath, payload, signal);
}
