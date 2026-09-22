import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { runTimedExecFile } from "../../acp/client-process.js";
import { hasStaleWindowsParent } from "../../acp/process-descendants.js";
import { QueueConnectionError } from "../../errors.js";
import {
  compareProcessBirthIdentity,
  getOwnProcessIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  type ProcessBirthIdentity,
  type ProcessTableEntry,
} from "../../process-identity.js";
import { isProcessAlive, isProcessDefinitelyDead } from "../../process-liveness.js";
import type { CapturedProcessIdentity } from "../lock-owner.js";
import { settlePendingQueueLeaseGuard, withQueueLeaseMutation } from "./lease-mutation.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";
import {
  assertQueueRetirementComplete,
  captureQueueRetirementReceipt,
  hasQueueRetirementReceipt,
  observeRetirementSnapshot,
  observeRetirementWitness,
  parseQueueRetirementReceipt,
  queueRetirementIncomplete,
  readRetirementSnapshot,
  retirementTimeRemaining,
  type QueueRetirementReceipt,
} from "./retirement-receipt.js";

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
  retirement?: QueueRetirementReceipt | null;
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

  const owner: QueueOwnerRecord = {
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
  // Keep invalid custody visible to close/recovery instead of treating this as
  // a malformed reservation that can age out, or letting close miss its owner.
  if (hasQueueRetirementReceipt(record)) {
    owner.retirement = parseQueueRetirementReceipt(record.retirement, owner);
  }
  return owner;
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
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (performance.now() <= deadline) {
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
  deadline = retirementDeadline(),
): Promise<void> {
  // Only a local lease supplies this receipt; a foreign owner's birth cannot
  // identify the current guard writer, even when both use the same numeric PID.
  await withQueueLeaseMutation(
    sessionId,
    async () => {
      await cleanupGuardedQueueOwnerFiles(sessionId, socketPath, isCurrent, deadline);
    },
    { capturedIdentity },
  );
}

async function cleanupGuardedQueueOwnerFiles(
  sessionId: string,
  socketPath: string,
  isCurrent: () => Promise<boolean>,
  deadline = retirementDeadline(),
): Promise<void> {
  if (!(await isCurrent())) {
    return;
  }
  const current = await readQueueOwnerRecord(sessionId);
  await assertQueueRetirementComplete(current?.retirement, deadline);
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

function ownerAcceptsWork(owner: QueueOwnerRecord): boolean {
  return (
    owner.retirement === undefined && ownerIsAlive(owner) && !isQueueOwnerHeartbeatStale(owner)
  );
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

async function dispatchQueueOwnerSignal(
  pid: number,
  signal: NodeJS.Signals,
  deadline: number,
): Promise<boolean> {
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
    timeoutMs: retirementTimeRemaining(deadline, PROCESS_SIGTERM_GRACE_MS),
    windowsHide: true,
  });
  return true;
}

async function terminateWithDispatch(
  pid: number,
  dispatch: (signal: NodeJS.Signals) => Promise<boolean>,
  hasExited: (pid: number) => boolean,
  deadline = Infinity,
): Promise<boolean> {
  for (const [signal, graceMs] of [
    ["SIGTERM", PROCESS_SIGTERM_GRACE_MS],
    ["SIGKILL", PROCESS_SIGKILL_GRACE_MS],
  ] as const) {
    if (!(await dispatch(signal))) {
      return false;
    }
    if (await waitForProcessExit(pid, Math.min(graceMs, deadline - performance.now()), hasExited)) {
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
  if (ownerAcceptsWork(observed)) {
    return observed;
  }

  await terminateQueueOwnerForSession(sessionId, observed, true);
  const current = await readQueueOwnerRecord(sessionId);
  return matchesQueueOwner(current, observed) && ownerAcceptsWork(current) ? current : undefined;
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
        const current = await readQueueOwnerRecord(lease.sessionId);
        if (!matchesQueueOwner(current, lease)) {
          return;
        }
        if (current.retirement === null) {
          throw queueRetirementIncomplete();
        }
        await replaceQueueOwnerRecord({
          ...current,
          heartbeatAt: nowIsoFactory(),
          queueDepth: Math.max(0, Math.round(options.queueDepth)),
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
  await stagePreparedQueueOwnerRecord(
    {
      pid: lease.pid,
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
    publish,
  );
}

async function replaceQueueOwnerRecord(owner: QueueOwnerRecord): Promise<void> {
  await stagePreparedQueueOwnerRecord(owner, async (tempPath) => {
    await fs.rename(tempPath, queueLockFilePath(owner.sessionId));
  });
}

async function stagePreparedQueueOwnerRecord(
  owner: QueueOwnerRecord,
  publish: (tempPath: string, payload: string) => Promise<void>,
): Promise<void> {
  const payload = JSON.stringify(owner, null, 2);
  await withTempFile(
    {
      rootDir: path.dirname(queueLockFilePath(owner.sessionId)),
      prefix: "owner",
      fileName: "lease",
    },
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

function retirementDeadline(): number {
  return performance.now() + PROCESS_SIGTERM_GRACE_MS + PROCESS_SIGKILL_GRACE_MS;
}

type QueueOwnerRetirement = {
  gone: boolean;
  unverified: boolean;
  leaseReleased: boolean;
  deadline: number;
  snapshot?: Map<number, ProcessTableEntry>;
  capturedIdentity?: CapturedProcessIdentity;
};

async function createQueueOwnerRetirement(deadline: number): Promise<QueueOwnerRetirement> {
  const snapshot =
    process.platform === "win32"
      ? await readRetirementSnapshot(deadline).catch(() => undefined)
      : undefined;
  return {
    gone: false,
    unverified: false,
    leaseReleased: false,
    deadline,
    snapshot,
    // Only self's row identifies this guard writer. The explicit empty carrier
    // also prevents every guard from retrying unavailable self discovery.
    capturedIdentity:
      process.platform === "win32"
        ? { processIdentity: snapshot?.get(process.pid)?.birth }
        : undefined,
  };
}

async function observeRetiringOwner(owner: QueueOwnerRecord, deadline: number) {
  return await observeProcessIncarnation(
    owner.pid,
    owner.processIdentity,
    process.platform === "win32" ? retirementTimeRemaining(deadline) : undefined,
  );
}

function retirementBlockedByHeartbeat(
  owner: QueueOwnerRecord,
  signal: NodeJS.Signals,
  requireStale: boolean,
): boolean {
  return (
    requireStale &&
    owner.retirement === undefined &&
    signal === "SIGTERM" &&
    !isQueueOwnerHeartbeatStale(owner)
  );
}

async function prepareWindowsRetirement(
  owner: QueueOwnerRecord,
  table: Map<number, ProcessTableEntry> | undefined,
  deadline: number,
) {
  if (owner.retirement === null || !table) {
    throw queueRetirementIncomplete();
  }
  owner.retirement = captureQueueRetirementReceipt(owner, owner.retirement, true, table);
  await replaceQueueOwnerRecord(owner);
  // Publication is the recovery boundary. Recheck birth after filesystem I/O
  // so neither a reused root nor its unrelated children receive taskkill.
  return await observeRetirementWitness(owner.retirement.root, deadline);
}

async function prepareRetiringOwner(
  owner: QueueOwnerRecord,
  signal: NodeJS.Signals,
  retirement: QueueOwnerRetirement,
): Promise<boolean> {
  const windows = process.platform === "win32";
  const table =
    windows && signal !== "SIGTERM"
      ? await readRetirementSnapshot(retirement.deadline).catch(() => undefined)
      : retirement.snapshot;
  let identity = windows
    ? observeRetirementSnapshot(owner, table)
    : await observeRetiringOwner(owner, retirement.deadline);
  if (identity === "matching" && windows) {
    identity = await prepareWindowsRetirement(owner, table, retirement.deadline);
  }
  retirement.gone = identity === "gone";
  retirement.unverified = identity === "unknown";
  return identity === "matching";
}

async function dispatchVerifiedQueueOwnerSignal(
  owner: QueueOwnerRecord,
  signal: NodeJS.Signals,
  requireStale: boolean,
  retirement: QueueOwnerRetirement,
): Promise<boolean> {
  return await withQueueLeaseMutation(
    owner.sessionId,
    async () => {
      const current = await readQueueOwnerRecord(owner.sessionId);
      retirement.leaseReleased = current?.pid !== owner.pid;
      if (
        !matchesQueueOwner(current, owner) ||
        retirementBlockedByHeartbeat(current, signal, requireStale)
      ) {
        return false;
      }
      if (current.retirement === null) {
        throw queueRetirementIncomplete();
      }
      if (!(await prepareRetiringOwner(current, signal, retirement))) {
        return false;
      }
      return await dispatchQueueOwnerSignal(owner.pid, signal, retirement.deadline);
    },
    { capturedIdentity: retirement.capturedIdentity },
  );
}

async function retireQueueOwner(
  owner: QueueOwnerRecord,
  requireStale: boolean,
  retirement: QueueOwnerRetirement,
): Promise<boolean> {
  const { deadline } = retirement;
  const exited = await terminateWithDispatch(
    owner.pid,
    (signal) => dispatchVerifiedQueueOwnerSignal(owner, signal, requireStale, retirement),
    isProcessDefinitelyDead,
    process.platform === "win32" ? deadline : Infinity,
  );
  if (await waitForReleasedOwner(owner, requireStale, retirement)) {
    return false;
  }
  // Windows ESRCH already proves this incarnation exited. POSIX must still
  // validate scope: a locally absent PID can name a foreign namespace's owner.
  const gone =
    retirement.gone ||
    (process.platform === "win32" && exited) ||
    (await observeRetiringOwner(owner, deadline)) === "gone";
  if (retirement.unverified && !gone) {
    throw unverifiedQueueOwnerError(owner);
  }
  return gone;
}

async function waitForReleasedOwner(
  owner: QueueOwnerRecord,
  requireStale: boolean,
  retirement: QueueOwnerRetirement,
): Promise<boolean> {
  if (retirement.unverified && requireStale) {
    throw unverifiedQueueOwnerError(owner);
  }
  if (retirement.leaseReleased || retirement.unverified) {
    // A released lease may belong to a successor; legacy owners may also finish
    // cooperative shutdown. Neither state permits signaling a remembered PID.
    await waitForProcessExit(
      owner.pid,
      Math.max(0, retirement.deadline - performance.now()),
      isProcessDefinitelyDead,
    );
    if (performance.now() >= retirement.deadline) {
      if (retirement.unverified) {
        throw unverifiedQueueOwnerError(owner);
      }
      // The selected lease was released. A passive timeout grants no custody
      // for another query, signal or cleanup of its absent/replacement record.
      return true;
    }
  }
  return false;
}

async function retireRecordedDescendants(
  owner: QueueOwnerRecord,
  retirement: QueueOwnerRetirement,
): Promise<void> {
  await withQueueLeaseMutation(
    owner.sessionId,
    async () => {
      const current = await readQueueOwnerRecord(owner.sessionId);
      if (!matchesQueueOwner(current, owner) || current.retirement === undefined) {
        return;
      }
      if (current.retirement === null || process.platform !== "win32") {
        throw queueRetirementIncomplete();
      }
      await retireSnapshotDescendants(current, current.retirement, retirement.deadline);
    },
    { capturedIdentity: retirement.capturedIdentity },
  );
}

function hasNewRetirementWitness(
  previous: QueueRetirementReceipt,
  receipt: QueueRetirementReceipt,
): boolean {
  const saved = new Map(
    previous.descendants.map((witness) => [witness.pid, witness.processIdentity]),
  );
  return receipt.descendants.some(
    (witness) =>
      compareProcessBirthIdentity(saved.get(witness.pid), witness.processIdentity) !== "matching",
  );
}

async function retireSnapshotDescendants(
  owner: QueueOwnerRecord,
  receipt: QueueRetirementReceipt,
  deadline: number,
): Promise<void> {
  while (receipt.descendants.length > 0) {
    const table = await readRetirementSnapshot(deadline);
    const discovered = captureQueueRetirementReceipt(owner, receipt, false, table);
    if (hasNewRetirementWitness(receipt, discovered)) {
      receipt = discovered;
      owner.retirement = receipt;
      await replaceQueueOwnerRecord(owner);
      // New custody must be durable before signaling. Filesystem work invalidates
      // the observation, so query again even if publication was fast.
      continue;
    }
    signalRecordedDescendants(discovered, table, deadline);
    await waitForRecordedDescendants(discovered, deadline);
    discovered.descendants = discovered.descendants.filter(
      (witness) => !isProcessDefinitelyDead(witness.pid),
    );
    // Old custody stays durable through dispatch and a crash. Pruning cannot
    // authorize a signal, so publish only after the synchronous batch finishes.
    receipt = discovered;
    owner.retirement = receipt;
    await replaceQueueOwnerRecord(owner);
  }
}

function leafFirstRetirementWitnesses(
  receipt: QueueRetirementReceipt,
  table: Map<number, ProcessTableEntry>,
) {
  const children = new Map(receipt.descendants.map((witness) => [witness.pid, 0]));
  for (const witness of receipt.descendants) {
    const parent = retirementParent(witness.pid, table);
    const count = children.get(parent);
    if (count !== undefined) {
      children.set(parent, count + 1);
    }
  }
  const pending = receipt.descendants.filter((witness) => children.get(witness.pid) === 0);
  const byPid = new Map(receipt.descendants.map((witness) => [witness.pid, witness]));
  for (let index = 0; index < pending.length; index += 1) {
    const parent = retirementParent(pending[index]!.pid, table);
    const count = children.get(parent);
    if (count !== undefined) {
      const remaining = count - 1;
      children.set(parent, remaining);
      if (remaining === 0) {
        pending.push(byPid.get(parent)!);
      }
    }
  }
  if (pending.length !== receipt.descendants.length) {
    throw queueRetirementIncomplete();
  }
  return pending;
}

function retirementParent(pid: number, table: Map<number, ProcessTableEntry>) {
  const identity = table.get(pid);
  // Ordering uses the same ancestry as discovery: a recycled creator PID can
  // point back to a younger descendant without forming a real process cycle.
  return identity && !hasStaleWindowsParent(identity, table.get(identity.parentPid))
    ? identity.parentPid
    : 0;
}

function signalRecordedDescendants(
  receipt: QueueRetirementReceipt,
  table: Map<number, ProcessTableEntry>,
  deadline: number,
): void {
  if (
    receipt.descendants.some((witness) => observeRetirementSnapshot(witness, table) === "unknown")
  ) {
    throw queueRetirementIncomplete();
  }
  const ordered = leafFirstRetirementWitnesses(receipt, table);
  let failure: unknown;
  // No await, publication or asynchronous error probe may split this verified
  // batch. Finish its independent members before surfacing a signal failure.
  for (const witness of ordered) {
    if (observeRetirementSnapshot(witness, table) !== "matching") {
      continue;
    }
    retirementTimeRemaining(deadline);
    try {
      process.kill(witness.pid, "SIGKILL");
    } catch (error) {
      if (!isProcessDefinitelyDead(witness.pid)) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    throw failure;
  }
}

async function waitForRecordedDescendants(
  receipt: QueueRetirementReceipt,
  deadline: number,
): Promise<void> {
  for (let waited = 0; waited < 1_000; waited += PROCESS_POLL_MS) {
    if (receipt.descendants.every((witness) => isProcessDefinitelyDead(witness.pid))) {
      return;
    }
    // Cheap ESRCH probes can finish promptly; full snapshots remain at least a
    // second apart while a survivor stays alive.
    await waitMs(Math.min(PROCESS_POLL_MS, retirementTimeRemaining(deadline)));
  }
}

async function assertNoPendingRetirement(owner: QueueOwnerRecord): Promise<void> {
  const current = await readQueueOwnerRecord(owner.sessionId);
  if (matchesQueueOwner(current, owner) && current.retirement !== undefined) {
    throw queueRetirementIncomplete();
  }
}

export async function terminateQueueOwnerForSession(
  sessionId: string,
  expectedOwner?: QueueOwnerRecord,
  requireStale = false,
): Promise<void> {
  await settlePendingQueueLeaseGuard(sessionId);
  const owner = expectedOwner ?? (await readQueueOwnerRecord(sessionId));
  if (!owner || owner.sessionId !== sessionId) {
    return;
  }
  if (owner.pid === process.pid) {
    if (owner.retirement !== undefined) {
      throw queueRetirementIncomplete();
    }
    return;
  }
  const deadline = retirementDeadline();
  const retirement = await createQueueOwnerRetirement(deadline);
  if (!(await retireQueueOwner(owner, requireStale, retirement))) {
    await assertNoPendingRetirement(owner);
    return;
  }
  await retireRecordedDescendants(owner, retirement);
  // Once this incarnation is confirmed gone it cannot return. Recheck the lease
  // generation during file cleanup; never signal a replacement occupying its PID.
  await cleanupQueueOwnerFiles(
    sessionId,
    owner.socketPath,
    () => ownsQueueLease(owner),
    retirement.capturedIdentity,
    deadline,
  );
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
