import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempFile } from "@openclaw/fs-safe/advanced";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { isProcessAlive } from "../../process-liveness.js";
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

  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await waitMs(PROCESS_POLL_MS);
  }

  return !isProcessAlive(pid);
}

async function cleanupQueueOwnerFiles(
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

async function ownsQueueLease(owner: QueueOwnerIdentity, requireStale = false): Promise<boolean> {
  const current = await readQueueOwnerRecord(owner.sessionId);
  return (
    current?.pid === owner.pid &&
    current.ownerGeneration === owner.ownerGeneration &&
    current.sessionId === owner.sessionId &&
    (!requireStale || !ownerIsAlive(current) || isQueueOwnerHeartbeatStale(current))
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
  for (const [signal, graceMs] of [
    ["SIGTERM", PROCESS_SIGTERM_GRACE_MS],
    ["SIGKILL", PROCESS_SIGKILL_GRACE_MS],
  ] as const) {
    if (beforeSignal && !(await beforeSignal(signal))) {
      return false;
    }
    try {
      process.kill(pid, signal);
    } catch {
      return false;
    }
    if (await waitForProcessExit(pid, graceMs)) {
      return true;
    }
  }
  return false;
}

export async function resolveUsableQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<QueueOwnerRecord | undefined> {
  if (ownerIsAlive(owner) && !isQueueOwnerHeartbeatStale(owner)) {
    return owner;
  }

  await terminateQueueOwnerForSession(sessionId, owner, true);
  const current = await readQueueOwnerRecord(sessionId);
  return current?.pid === owner.pid &&
    current.ownerGeneration === owner.ownerGeneration &&
    ownerIsAlive(current) &&
    !isQueueOwnerHeartbeatStale(current)
    ? current
    : undefined;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
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
    ...mcpConfigMetadata,
    updates: Promise.resolve(),
    released: false,
  };

  try {
    await stageQueueOwnerRecord(
      lease,
      0,
      () => createdAt,
      async (tempPath, payload) => {
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
      },
    );
    await removeSocketFile(socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return lease;
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
    await cleanupQueueOwnerFiles(sessionId, queueSocketPath(sessionId), async () => {
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
    await stageQueueOwnerRecord(lease, options.queueDepth, nowIsoFactory, async (tempPath) => {
      if (await ownsQueueLease(lease)) {
        await fs.rename(tempPath, lease.lockPath);
      }
    });
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
  await cleanupQueueOwnerFiles(lease.sessionId, lease.socketPath, () => ownsQueueLease(lease));
}

export async function terminateQueueOwnerForSession(
  sessionId: string,
  expectedOwner?: QueueOwnerRecord,
  requireStale = false,
): Promise<void> {
  const owner = expectedOwner ?? (await readQueueOwnerRecord(sessionId));
  if (!owner || owner.sessionId !== sessionId) {
    return;
  }

  if (ownerIsAlive(owner)) {
    // A final queued heartbeat must not undo retirement after SIGTERM.
    await terminateProcess(owner.pid, (signal) =>
      ownsQueueLease(owner, requireStale && signal === "SIGTERM"),
    );
  }
  if (ownerIsAlive(owner)) {
    return;
  }
  await cleanupQueueOwnerFiles(sessionId, owner.socketPath, () => ownsQueueLease(owner));
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
