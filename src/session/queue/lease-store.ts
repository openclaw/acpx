import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { runTimedExecFile } from "../../acp/client-process.js";
import { QueueConnectionError } from "../../errors.js";
import {
  getOwnProcessIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  type ProcessBirthIdentity,
} from "../../process-identity.js";
import { isProcessAlive, isProcessDefinitelyDead } from "../../process-liveness.js";
import type { CapturedProcessIdentity } from "../lock-owner.js";
import { settlePendingQueueLeaseGuard, withQueueLeaseMutation } from "./lease-mutation.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

// Budget for graceful SIGTERM shutdown of a queue-owner process.
// Allow the client's eight-second descendant cleanup budget plus cancellation
// and event-loop headroom before forcibly terminating the owner itself.
const PROCESS_SIGTERM_GRACE_MS = process.platform === "win32" ? 4_000 : 12_000;
// After SIGKILL the OS terminates the process almost immediately; 1 500 ms is generous.
const PROCESS_SIGKILL_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  processIdentity?: ProcessBirthIdentity;
  queueDepth: number;
  sharedRuntime?: boolean;
  sessionWatch?: boolean;
  persistsControlState?: boolean;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
};

type QueueOwnerIdentity = Pick<QueueOwnerRecord, "pid" | "sessionId" | "ownerGeneration">;

export type QueueOwnerLease = QueueOwnerIdentity & {
  lockPath: string;
  socketPath: string;
  createdAt: string;
  processIdentity?: ProcessBirthIdentity;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  updates: Promise<void>;
  released: boolean;
};

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
  stale: boolean;
};

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (!hasValidQueueOwnerRecordFields(record)) {
    return null;
  }
  // An absent or invalid birth identity makes retirement unverified, not the
  // entire lease malformed: collision recovery must preserve its custody.
  const processIdentity = parseProcessBirthIdentity(record.processIdentity);

  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
    ...(processIdentity ? { processIdentity } : {}),
    ...parseQueueOwnerCapabilities(record),
    ...(typeof record.mcpConfigPath === "string" ? { mcpConfigPath: record.mcpConfigPath } : {}),
    ...(typeof record.mcpConfigFingerprint === "string"
      ? { mcpConfigFingerprint: record.mcpConfigFingerprint }
      : {}),
  };
}

function parseQueueOwnerCapabilities(
  record: Record<string, unknown>,
): Pick<QueueOwnerRecord, "sharedRuntime" | "sessionWatch" | "persistsControlState"> {
  return {
    ...(record.sharedRuntime === true ? { sharedRuntime: true } : {}),
    ...(record.sessionWatch === true ? { sessionWatch: true } : {}),
    ...(record.persistsControlState === true ? { persistsControlState: true } : {}),
  };
}

function hasValidQueueOwnerRecordFields(
  record: Record<string, unknown>,
): record is Record<string, unknown> &
  Pick<
    QueueOwnerRecord,
    | "pid"
    | "sessionId"
    | "socketPath"
    | "createdAt"
    | "heartbeatAt"
    | "ownerGeneration"
    | "queueDepth"
  > {
  return (
    !Array.isArray(record) &&
    isPositiveInteger(record.pid) &&
    typeof record.sessionId === "string" &&
    typeof record.socketPath === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    isPositiveInteger(record.ownerGeneration) &&
    isNonNegativeInteger(record.queueDepth)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function createOwnerGeneration(): number {
  return randomInt(1, 2 ** 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return true;
  }
  return Date.now() - heartbeatMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}

async function ensureQueueDir(): Promise<void> {
  const baseDir = queueBaseDir();
  try {
    await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
    await fs.chmod(baseDir, 0o700);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare queue directory ${baseDir}: ${message}`, {
      cause: error,
    });
  }
  const socketDir = queueSocketBaseDir();
  if (socketDir) {
    try {
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare queue socket directory ${socketDir}: ${message}`, {
        cause: error,
      });
    }
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  hasExited: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (hasExited(pid)) {
      return true;
    }
    await waitMs(PROCESS_POLL_MS);
  }

  return hasExited(pid);
}

async function cleanupQueueOwnerFiles(
  sessionId: string,
  socketPath: string,
  isCurrent: () => Promise<boolean>,
  capturedIdentity?: CapturedProcessIdentity,
): Promise<void> {
  // Only a local lease supplies this receipt; a foreign owner's birth cannot
  // identify the current guard writer, even when both use the same numeric PID.
  await withQueueLeaseMutation(
    sessionId,
    async () => {
      await cleanupGuardedQueueOwnerFiles(sessionId, socketPath, isCurrent);
    },
    { capturedIdentity },
  );
}

async function cleanupGuardedQueueOwnerFiles(
  sessionId: string,
  socketPath: string,
  isCurrent: () => Promise<boolean>,
): Promise<void> {
  if (!(await isCurrent())) {
    return;
  }
  await removeSocketFile(socketPath).catch(() => {
    // ignore stale socket cleanup failures
  });

  if (!(await isCurrent())) {
    return;
  }
  await fs.unlink(queueLockFilePath(sessionId)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function ownsQueueLease(owner: QueueOwnerIdentity): Promise<boolean> {
  const current = await readQueueOwnerRecord(owner.sessionId);
  return matchesQueueOwner(current, owner);
}

function matchesQueueOwner(
  current: QueueOwnerRecord | undefined,
  expected: QueueOwnerIdentity,
): current is QueueOwnerRecord {
  return (
    current?.sessionId === expected.sessionId &&
    current.pid === expected.pid &&
    current.ownerGeneration === expected.ownerGeneration
  );
}

function ownerIsAlive(owner: QueueOwnerRecord): boolean {
  return owner.pid === process.pid || isProcessAlive(owner.pid);
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const lockPath = queueLockFilePath(sessionId);
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed?.sessionId === sessionId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function terminateProcess(
  pid: number,
  beforeSignal?: (signal: NodeJS.Signals) => Promise<boolean>,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }
  return await terminateWithDispatch(
    pid,
    async (signal) => {
      if (beforeSignal && !(await beforeSignal(signal))) {
        return false;
      }
      return dispatchSignal(pid, signal);
    },
    (target) => !isProcessAlive(target),
  );
}

function dispatchSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function dispatchQueueOwnerSignal(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  if (process.platform !== "win32") {
    return dispatchSignal(pid, signal);
  }
  // Windows SIGTERM bypasses the owner's shutdown handler. Retire its tree
  // before losing the parent; a failed helper must not authorize lease cleanup.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows queue-owner cleanup requires an absolute SystemRoot directory");
  }
  // Do not let the working directory supply an executable named taskkill.
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  await runTimedExecFile(taskkill, ["/pid", String(pid), "/T", "/F"], {
    timeoutMs: PROCESS_SIGTERM_GRACE_MS,
    windowsHide: true,
  });
  return true;
}

async function terminateWithDispatch(
  pid: number,
  dispatch: (signal: NodeJS.Signals) => Promise<boolean>,
  hasExited: (pid: number) => boolean,
): Promise<boolean> {
  for (const [signal, graceMs] of [
    ["SIGTERM", PROCESS_SIGTERM_GRACE_MS],
    ["SIGKILL", PROCESS_SIGKILL_GRACE_MS],
  ] as const) {
    if (!(await dispatch(signal))) {
      return false;
    }
    if (await waitForProcessExit(pid, graceMs, hasExited)) {
      return true;
    }
  }
  return false;
}

export async function resolveUsableQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<QueueOwnerRecord | undefined> {
  await settlePendingQueueLeaseGuard(sessionId);
  const observed = await readQueueOwnerRecord(sessionId);
  if (!matchesQueueOwner(observed, owner)) {
    return undefined;
  }
  if (ownerIsAlive(observed) && !isQueueOwnerHeartbeatStale(observed)) {
    return observed;
  }

  await terminateQueueOwnerForSession(sessionId, observed, true);
  const current = await readQueueOwnerRecord(sessionId);
  return matchesQueueOwner(current, observed) &&
    ownerIsAlive(current) &&
    !isQueueOwnerHeartbeatStale(current)
    ? current
    : undefined;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  await settlePendingQueueLeaseGuard(sessionId);
  const observed = await readQueueOwnerRecord(sessionId);
  if (!observed) {
    return undefined;
  }

  const owner = await resolveUsableQueueOwner(sessionId, observed);
  if (!owner) {
    return undefined;
  }

  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive: true,
    stale: isQueueOwnerHeartbeatStale(owner),
  };
}

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  mcpConfigOrNowIsoFactory?:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string),
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLease | undefined> {
  const { mcpConfigPath, clock } = resolveLeaseArguments(mcpConfigOrNowIsoFactory, nowIsoFactory);
  const mcpConfigFingerprint = readMcpConfigFingerprint(mcpConfigOrNowIsoFactory);
  const mcpConfigMetadata = createMcpConfigMetadata(mcpConfigPath, mcpConfigFingerprint);
  const processIdentity = await getOwnProcessIdentity();
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  const createdAt = clock();
  const ownerGeneration = createOwnerGeneration();
  const lease: QueueOwnerLease = {
    pid: process.pid,
    sessionId,
    lockPath,
    socketPath,
    createdAt,
    ownerGeneration,
    ...(processIdentity ? { processIdentity } : {}),
    ...mcpConfigMetadata,
    updates: Promise.resolve(),
    released: false,
  };
  const reservation = { pid: lease.pid, sessionId, ownerGeneration, published: false };

  try {
    return await withQueueLeaseMutation(
      sessionId,
      async () => {
        await stageQueueOwnerRecord(lease, 0, clock, async (tempPath, payload) => {
          try {
            await fs.link(tempPath, lockPath);
          } catch (error) {
            if (!isHardlinkFallbackError(error)) {
              throw error;
            }
            // Some volumes cannot hardlink. Preserve exclusive reservation there;
            // collision recovery leaves incomplete, recent reservations alone.
            await fs.writeFile(lockPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
          }
          reservation.published = true;
        });
        await removeSocketFile(socketPath).catch(() => {
          // best-effort stale socket cleanup after ownership is acquired
        });
        return lease;
      },
      { reservation, capturedIdentity: lease },
    );
  } catch (error) {
    return await handleLeaseCollision(sessionId, error);
  }
}

function readMcpConfigFingerprint(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
): string | undefined {
  return typeof mcpConfigOrNowIsoFactory === "object"
    ? mcpConfigOrNowIsoFactory?.fingerprint
    : undefined;
}

function createMcpConfigMetadata(
  mcpConfigPath: string | undefined,
  mcpConfigFingerprint: string | undefined,
): { mcpConfigPath?: string; mcpConfigFingerprint?: string } {
  return {
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(mcpConfigFingerprint ? { mcpConfigFingerprint } : {}),
  };
}

async function handleLeaseCollision(sessionId: string, error: unknown): Promise<undefined> {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }

  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    await cleanupAbandonedReservation(sessionId);
    return undefined;
  }

  await resolveUsableQueueOwner(sessionId, owner);
  return undefined;
}

async function cleanupAbandonedReservation(sessionId: string): Promise<void> {
  const lockPath = queueLockFilePath(sessionId);
  await withQueueLeaseMutation(sessionId, async () => {
    try {
      const observed = await fs.lstat(lockPath, { bigint: true });
      if (
        !observed.isFile() ||
        Date.now() - Number(observed.mtimeMs) <= QUEUE_OWNER_STALE_HEARTBEAT_MS
      ) {
        return;
      }
      const raw = await fs.readFile(lockPath, "utf8");
      if (await readQueueOwnerRecord(sessionId)) {
        return;
      }
      await cleanupGuardedQueueOwnerFiles(sessionId, queueSocketPath(sessionId), async () => {
        const current = await fs.lstat(lockPath, { bigint: true });
        return (
          current.isFile() &&
          current.dev === observed.dev &&
          current.ino === observed.ino &&
          current.mtimeNs === observed.mtimeNs &&
          (await fs.readFile(lockPath, "utf8")) === raw
        );
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  });
}

function resolveLeaseArguments(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
  nowIsoFactory: () => string,
): { mcpConfigPath: string | undefined; clock: () => string } {
  if (typeof mcpConfigOrNowIsoFactory === "string") {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory, clock: nowIsoFactory };
  }
  if (typeof mcpConfigOrNowIsoFactory === "function") {
    return { mcpConfigPath: undefined, clock: mcpConfigOrNowIsoFactory };
  }
  if (mcpConfigOrNowIsoFactory) {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory.path, clock: nowIsoFactory };
  }
  return { mcpConfigPath: undefined, clock: nowIsoFactory };
}

export function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<void> {
  if (lease.released) {
    return Promise.resolve();
  }
  const update = lease.updates.then(async () => {
    await withQueueLeaseMutation(
      lease.sessionId,
      async () => {
        if (!(await ownsQueueLease(lease))) {
          return;
        }
        await stageQueueOwnerRecord(lease, options.queueDepth, nowIsoFactory, async (tempPath) => {
          await fs.rename(tempPath, lease.lockPath);
        });
      },
      { capturedIdentity: lease },
    );
  });
  lease.updates = update.catch(() => {});
  return update;
}

async function stageQueueOwnerRecord(
  lease: QueueOwnerLease,
  queueDepth: number,
  clock: () => string,
  publish: (tempPath: string, payload: string) => Promise<void>,
): Promise<void> {
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId: lease.sessionId,
      socketPath: lease.socketPath,
      createdAt: lease.createdAt,
      heartbeatAt: clock(),
      ownerGeneration: lease.ownerGeneration,
      ...(lease.processIdentity ? { processIdentity: lease.processIdentity } : {}),
      queueDepth: Math.max(0, Math.round(queueDepth)),
      sharedRuntime: true,
      sessionWatch: true,
      persistsControlState: true,
      ...(lease.mcpConfigPath ? { mcpConfigPath: lease.mcpConfigPath } : {}),
      ...(lease.mcpConfigFingerprint ? { mcpConfigFingerprint: lease.mcpConfigFingerprint } : {}),
    },
    null,
    2,
  );
  await withTempFile(
    { rootDir: path.dirname(lease.lockPath), prefix: "owner", fileName: "lease" },
    async (tempPath) => {
      await fs.writeFile(tempPath, `${payload}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await publish(tempPath, `${payload}\n`);
    },
  );
}

export async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  lease.released = true;
  await lease.updates;
  await cleanupQueueOwnerFiles(
    lease.sessionId,
    lease.socketPath,
    () => ownsQueueLease(lease),
    lease,
  );
}

function unverifiedQueueOwnerError(owner: QueueOwnerRecord): QueueConnectionError {
  return new QueueConnectionError(
    `Cannot safely retire queue owner pid ${owner.pid}: its process birth identity is unverified. Its lease was retained. Retry from the same local process namespace with process-query access, or let the owner finish normal shutdown or idle expiry.`,
    { detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED", origin: "queue", retryable: true },
  );
}

type QueueOwnerRetirement = { gone: boolean; unverified: boolean; leaseReleased: boolean };

async function dispatchVerifiedQueueOwnerSignal(
  owner: QueueOwnerRecord,
  signal: NodeJS.Signals,
  requireStale: boolean,
  retirement: QueueOwnerRetirement,
): Promise<boolean> {
  return await withQueueLeaseMutation(owner.sessionId, async () => {
    const current = await readQueueOwnerRecord(owner.sessionId);
    retirement.leaseReleased = current?.pid !== owner.pid;
    if (
      !matchesQueueOwner(current, owner) ||
      (requireStale && signal === "SIGTERM" && !isQueueOwnerHeartbeatStale(current))
    ) {
      return false;
    }
    // Generation protects the lease; a fresh OS birth protects the PID. The
    // same numeric PID can belong to an unrelated process after an owner crash.
    const identity = await observeProcessIncarnation(current.pid, current.processIdentity);
    if (identity !== "matching") {
      retirement.gone = identity === "gone";
      retirement.unverified = identity === "unknown";
      return false;
    }
    return await dispatchQueueOwnerSignal(owner.pid, signal);
  });
}

async function retireQueueOwner(owner: QueueOwnerRecord, requireStale: boolean): Promise<boolean> {
  const deadline = performance.now() + PROCESS_SIGTERM_GRACE_MS + PROCESS_SIGKILL_GRACE_MS;
  const retirement: QueueOwnerRetirement = { gone: false, unverified: false, leaseReleased: false };
  await terminateWithDispatch(
    owner.pid,
    (signal) => dispatchVerifiedQueueOwnerSignal(owner, signal, requireStale, retirement),
    isProcessDefinitelyDead,
  );
  if (retirement.unverified && requireStale) {
    throw unverifiedQueueOwnerError(owner);
  }
  if (retirement.leaseReleased || retirement.unverified) {
    // A released lease may belong to a successor; legacy owners may also finish
    // cooperative shutdown. Neither state permits signaling a remembered PID.
    await waitForProcessExit(
      owner.pid,
      Math.max(0, deadline - performance.now()),
      isProcessDefinitelyDead,
    );
  }
  // Numeric exit is only a waiting hint. Revalidate the expected scope before
  // cleanup: a locally absent PID can still name a foreign namespace's owner.
  const gone =
    retirement.gone ||
    (await observeProcessIncarnation(owner.pid, owner.processIdentity)) === "gone";
  if (retirement.unverified && !gone) {
    throw unverifiedQueueOwnerError(owner);
  }
  return gone;
}

export async function terminateQueueOwnerForSession(
  sessionId: string,
  expectedOwner?: QueueOwnerRecord,
  requireStale = false,
): Promise<void> {
  await settlePendingQueueLeaseGuard(sessionId);
  const owner = expectedOwner ?? (await readQueueOwnerRecord(sessionId));
  if (!owner || owner.sessionId !== sessionId || owner.pid === process.pid) {
    return;
  }

  if (!(await retireQueueOwner(owner, requireStale))) {
    return;
  }
  // Once this incarnation is confirmed gone it cannot return. Recheck the lease
  // generation during file cleanup; never signal a replacement occupying its PID.
  await cleanupQueueOwnerFiles(sessionId, owner.socketPath, () => ownsQueueLease(owner));
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
