import { SessionNotFoundError } from "../errors.js";
import { isProcessAlive } from "../process-liveness.js";
import type { SessionRecord } from "../types.js";
import {
  SessionWatchError,
  watchSession as watchJournal,
  type SessionWatchEvent,
} from "./journal.js";
import { readSessionRecord } from "./persistence.js";
import { readQueueOwnerRecord } from "./queue/lease-store.js";

async function continueWatching(
  recordId: string,
  pendingRequestId: string | null,
  observation: { missingRequest: string | null },
): Promise<boolean> {
  const owner = await readQueueOwnerRecord(recordId);
  if (owner && isProcessAlive(owner.pid)) {
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
      const observation: { missingRequest: string | null } = { missingRequest: null };
      return watchJournal({
        ...options,
        continueWatching: (record, requestId) =>
          continueWatching(record.acpxRecordId, requestId, observation),
      })[Symbol.asyncIterator]();
    },
  };
}
