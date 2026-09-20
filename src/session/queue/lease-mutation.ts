import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { QueueConnectionError } from "../../errors.js";
import { isProcessDefinitelyDead } from "../../process-liveness.js";
import { queueLockFilePath } from "./paths.js";

const GUARD_WAIT_MS = 2_000;

type QueueLeaseIdentity = {
  pid: number;
  sessionId: string;
  ownerGeneration: number;
};

export type QueueLeaseReservation = QueueLeaseIdentity & { published: boolean };

type FailedSettlement = {
  guard: FileLockHandle;
  reservation?: QueueLeaseIdentity;
};

type LocalMutationState = {
  tail: Promise<void>;
  failed?: FailedSettlement;
};

// Local sequencing prevents another caller helping settlement before the mutation ends.
const localMutations = new Map<string, LocalMutationState>();

export class QueueLeaseGuardSettlementError extends QueueConnectionError {
  constructor(errors: unknown[]) {
    super("Queue lease guard settlement failed; cleanup remains retryable", {
      detailCode: "QUEUE_LEASE_GUARD_SETTLEMENT_FAILED",
      origin: "queue",
      retryable: false,
      cause: new AggregateError(errors, "Queue lease mutation and settlement errors"),
    });
  }
}

async function canonicalLeasePath(sessionId: string): Promise<string> {
  const requested = queueLockFilePath(sessionId);
  try {
    return path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return path.resolve(requested);
    }
    throw error;
  }
}

function guardOwnerHasExited({ payload }: { payload: unknown }): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "pid" in payload &&
    typeof payload.pid === "number" &&
    isProcessDefinitelyDead(payload.pid)
  );
}

async function acquireGuard(lockPath: string): Promise<FileLockHandle> {
  return await acquireFileLock(lockPath, {
    managerKey: "acpx.queue-lease-mutation",
    lockPath: `${lockPath}.guard`,
    staleMs: Infinity,
    timeoutMs: GUARD_WAIT_MS,
    retry: { minTimeout: 5, maxTimeout: 15, factor: 1, randomize: false },
    staleRecovery: "remove-if-unchanged",
    payload: () => ({ pid: process.pid }),
    shouldReclaim: guardOwnerHasExited,
    shouldRemoveStaleLock: guardOwnerHasExited,
  });
}

function matchesReservation(value: unknown, expected: QueueLeaseIdentity): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.pid === expected.pid &&
    record.sessionId === expected.sessionId &&
    record.ownerGeneration === expected.ownerGeneration
  );
}

async function rollbackReservation(lockPath: string, expected: QueueLeaseIdentity): Promise<void> {
  try {
    if (!(await fs.lstat(lockPath)).isFile()) {
      return;
    }
    const raw = await fs.readFile(lockPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (matchesReservation(value, expected)) {
      await fs.unlink(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function settleReceipt(lockPath: string, receipt: FailedSettlement): Promise<void> {
  if (receipt.reservation) {
    if (!(await receipt.guard.verifyStillHeld())) {
      await receipt.guard.release();
      receipt.guard = await acquireGuard(lockPath);
    }
    await rollbackReservation(lockPath, receipt.reservation);
    receipt.reservation = undefined;
  }
  await receipt.guard.release();
}

async function settleFailedGuard(lockPath: string, state: LocalMutationState): Promise<void> {
  const failed = state.failed;
  if (!failed) {
    return;
  }
  try {
    await settleReceipt(lockPath, failed);
    if (state.failed === failed) {
      state.failed = undefined;
    }
  } catch (error) {
    throw new QueueLeaseGuardSettlementError([error]);
  }
}

async function locallySerialized<T>(
  lockPath: string,
  run: (state: LocalMutationState) => Promise<T>,
): Promise<T> {
  let state = localMutations.get(lockPath);
  if (!state) {
    state = { tail: Promise.resolve() };
    localMutations.set(lockPath, state);
  }
  const current = state;
  const operation = current.tail.then(async () => await run(current));
  const tail = operation.then(
    () => {},
    () => {},
  );
  current.tail = tail;
  try {
    return await operation;
  } finally {
    if (current.tail === tail && !current.failed && localMutations.get(lockPath) === current) {
      localMutations.delete(lockPath);
    }
  }
}

export async function settlePendingQueueLeaseGuard(sessionId: string): Promise<void> {
  if (localMutations.size === 0) {
    return;
  }
  const lockPath = await canonicalLeasePath(sessionId);
  if (!localMutations.has(lockPath)) {
    return;
  }
  await locallySerialized(lockPath, async (state) => await settleFailedGuard(lockPath, state));
}

export async function withQueueLeaseMutation<T>(
  sessionId: string,
  mutate: () => Promise<T>,
  reservation?: QueueLeaseReservation,
): Promise<T> {
  await fs.mkdir(path.dirname(queueLockFilePath(sessionId)), { recursive: true, mode: 0o700 });
  const lockPath = await canonicalLeasePath(sessionId);
  const expected = reservation
    ? {
        pid: reservation.pid,
        sessionId: reservation.sessionId,
        ownerGeneration: reservation.ownerGeneration,
      }
    : undefined;
  const publishedReservation = () => (reservation?.published ? expected : undefined);
  return await locallySerialized(lockPath, async (state) => {
    await settleFailedGuard(lockPath, state);
    const guard = await acquireGuard(lockPath);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await mutate() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const published = publishedReservation();
    const receipt: FailedSettlement = {
      guard,
      reservation: outcome.ok ? undefined : published,
    };
    try {
      await settleReceipt(lockPath, receipt);
    } catch (error) {
      // A successful publication is still unadmitted when final guard release fails.
      if (outcome.ok) {
        receipt.reservation = published;
      }
      state.failed = receipt;
      throw new QueueLeaseGuardSettlementError(outcome.ok ? [error] : [outcome.error, error]);
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  });
}
