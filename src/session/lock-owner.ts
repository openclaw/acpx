import {
  compareProcessBirthIdentity,
  getOwnProcessIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  type ProcessBirthIdentity,
} from "../process-identity.js";

const OBSERVATION_REUSE_MS = 1_000;
const IDENTITY_QUERY_TIMEOUT_MS = 1_000;

// The receipt's presence means discovery already ran, including an unavailable birth.
export type CapturedProcessIdentity = { processIdentity?: ProcessBirthIdentity };

export type LockOwner = {
  payload: { pid: number; processIdentity?: ProcessBirthIdentity };
  hasExited(payload: unknown, fresh?: boolean, signal?: AbortSignal): Promise<boolean>;
};

type PreservedOwner = { pid: number; identity: ProcessBirthIdentity; checkedAt: number };

export function lockOwnerPid(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("pid" in value)) {
    return undefined;
  }
  const pid = value.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function canReuseObservation(
  preserved: PreservedOwner | undefined,
  pid: number,
  identity: ProcessBirthIdentity,
  fresh?: boolean,
): boolean {
  return (
    !fresh &&
    preserved?.pid === pid &&
    compareProcessBirthIdentity(preserved.identity, identity) === "matching" &&
    performance.now() - preserved.checkedAt < OBSERVATION_REUSE_MS
  );
}

export async function createLockOwner(
  options: { signal?: AbortSignal; capturedIdentity?: CapturedProcessIdentity } = {},
): Promise<LockOwner> {
  const { signal, capturedIdentity } = options;
  signal?.throwIfAborted();
  const processIdentity =
    capturedIdentity === undefined
      ? await getOwnProcessIdentity()
      : capturedIdentity.processIdentity;
  signal?.throwIfAborted();
  let preserved: PreservedOwner | undefined;
  return {
    payload: { pid: process.pid, processIdentity },
    async hasExited(payload, fresh, signal) {
      signal?.throwIfAborted();
      const pid = lockOwnerPid(payload);
      if (!pid) {
        return false;
      }
      const identity = parseProcessBirthIdentity(
        (payload as { processIdentity?: unknown }).processIdentity,
      );
      // fs-safe retries every few milliseconds. Reuse only custody-preserving
      // observations within this acquisition, never a destructive decision.
      if (identity && canReuseObservation(preserved, pid, identity, fresh)) {
        return false;
      }
      // The canonical observer validates Linux scope before accepting even ESRCH.
      const incarnation = await observeProcessIncarnation(pid, identity, IDENTITY_QUERY_TIMEOUT_MS);
      signal?.throwIfAborted();
      if (identity && incarnation !== "gone") {
        preserved = { pid, identity, checkedAt: performance.now() };
      }
      return incarnation === "gone";
    },
  };
}
