import { SessionNotFoundError } from "../errors.js";
import { observeProcessIncarnation, type ProcessIncarnation } from "../process-identity.js";
import type { SessionRecord } from "../types.js";
import {
  SessionWatchError,
  watchSession as watchJournal,
  type SessionWatchEvent,
} from "./journal.js";
import { readSessionRecord } from "./persistence.js";
import { readQueueOwnerRecord, type QueueOwnerRecord } from "./queue/lease-store.js";

const OWNER_OBSERVATION_REUSE_MS = 1_000;
const OWNER_QUERY_TIMEOUT_MS = 1_000;

type WatchObservation = {
  ownerKey: string | null;
  incarnation?: { state: ProcessIncarnation; checkedAt: number; decisionPending: boolean };
  missingRequest: string | null;
};

function reuseObservation(cached: WatchObservation["incarnation"]): boolean {
  if (!cached) {
    return false;
  }
  // A query first forces a journal reread, then gets one decision pass even
  // after a slow consumer. Otherwise repeated probes can defer errors forever.
  if (cached.decisionPending) {
    cached.decisionPending = false;
    return true;
  }
  return (
    cached.state === "gone" || performance.now() - cached.checkedAt < OWNER_OBSERVATION_REUSE_MS
  );
}

function selectOwner(owner: QueueOwnerRecord | undefined, observation: WatchObservation): boolean {
  // Heartbeats and retirement receipts do not change the owner's incarnation.
  // Keep only this small key, never the potentially large descendant receipt.
  const key = owner
    ? JSON.stringify([owner.pid, owner.ownerGeneration, owner.processIdentity])
    : null;
  if (key === observation.ownerKey) {
    return false;
  }
  observation.ownerKey = key;
  observation.incarnation = undefined;
  observation.missingRequest = null;
  return true;
}

async function runningOwner(
  recordId: string,
  observation: WatchObservation,
): Promise<{ owner?: QueueOwnerRecord; queried: boolean }> {
  let owner = await readQueueOwnerRecord(recordId);
  selectOwner(owner, observation);
  if (!owner) {
    return { queried: false };
  }
  const cached = observation.incarnation;
  let queried = false;
  // A verified departed incarnation cannot return. Cache that fact even for
  // idle watches; other observations are bounded independently of journal polls.
  if (!reuseObservation(cached)) {
    queried = true;
    const state = await observeProcessIncarnation(
      owner.pid,
      owner.processIdentity,
      OWNER_QUERY_TIMEOUT_MS,
    );
    owner = await readQueueOwnerRecord(recordId);
    if (selectOwner(owner, observation)) {
      // A replacement may have settled or recovered the journal during the
      // query. Let the reader revisit it before interpreting the old result.
      return { owner, queried };
    }
    observation.incarnation = { state, checkedAt: performance.now(), decisionPending: true };
  }
  return { owner: observation.incarnation?.state === "gone" ? undefined : owner, queried };
}

async function continueWatching(
  recordId: string,
  pendingRequestId: string | null,
  observation: WatchObservation,
): Promise<boolean> {
  const { owner, queried } = await runningOwner(recordId, observation);
  if (queried) {
    // A probe can outlast a journal update, including replacement by an older
    // owner. Revisit the journal before any unsupported/unknown/end decision.
    observation.missingRequest = owner ? null : pendingRequestId;
    return true;
  }
  if (owner) {
    if (!owner.sessionWatch) {
      throw new SessionWatchError(
        "WATCH_OWNER_UNSUPPORTED",
        "This running session owner predates passive watching. Let it expire when idle or explicitly close the session before starting new work.",
      );
    }
    observation.missingRequest = null;
    return true;
  }
  if (pendingRequestId && pendingRequestId === observation.missingRequest) {
    throw new SessionWatchError(
      "WATCH_OUTCOME_UNKNOWN",
      `Session owner ended without a settled result for request ${pendingRequestId}; its outcome is unknown. Resume watching from the last cursor after recovery, and do not automatically replay the prompt.`,
    );
  }
  observation.missingRequest = pendingRequestId;
  if (pendingRequestId) {
    return true;
  }
  return await isSessionOpen(recordId);
}

async function isSessionOpen(recordId: string): Promise<boolean> {
  const record = await readSessionRecord(recordId);
  if (!record || record.acpxRecordId !== recordId) {
    throw new SessionNotFoundError(recordId);
  }
  return record.closed !== true;
}

export function watchSession(options: {
  record: SessionRecord | Promise<SessionRecord>;
  cursor?: string;
  signal?: AbortSignal;
}): AsyncIterable<SessionWatchEvent> {
  return {
    [Symbol.asyncIterator]() {
      const observation: WatchObservation = { ownerKey: null, missingRequest: null };
      return watchJournal({
        ...options,
        continueWatching: (record, requestId) =>
          continueWatching(record.acpxRecordId, requestId, observation),
      })[Symbol.asyncIterator]();
    },
  };
}
