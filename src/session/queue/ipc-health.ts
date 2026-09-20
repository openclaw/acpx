import { connectToQueueOwner } from "./ipc-transport.js";
import { settlePendingQueueLeaseGuard } from "./lease-mutation.js";
import {
  readQueueOwnerRecord,
  resolveUsableQueueOwner,
  type QueueOwnerRecord,
} from "./lease-store.js";

export type QueueOwnerHealth = {
  sessionId: string;
  hasLease: boolean;
  healthy: boolean;
  socketReachable: boolean;
  pidAlive: boolean;
  pid?: number;
  socketPath?: string;
  ownerGeneration?: number;
  queueDepth?: number;
};

async function isStillCurrent(owner: QueueOwnerRecord): Promise<boolean> {
  const current = await readQueueOwnerRecord(owner.sessionId);
  return current?.pid === owner.pid && current.ownerGeneration === owner.ownerGeneration;
}

export async function probeQueueOwnerHealth(sessionId: string): Promise<QueueOwnerHealth> {
  await settlePendingQueueLeaseGuard(sessionId);
  const ownerRecord = await readQueueOwnerRecord(sessionId);
  if (!ownerRecord) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  const owner = await resolveUsableQueueOwner(sessionId, ownerRecord);
  if (!owner) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  let socketReachable = false;
  try {
    const socket = await connectToQueueOwner(owner, 2);
    if (socket) {
      socketReachable = true;
      if (!socket.destroyed) {
        socket.end();
      }
    }
  } catch {
    socketReachable = false;
  }

  if (!(await isStillCurrent(owner))) {
    return { sessionId, hasLease: false, healthy: false, socketReachable: false, pidAlive: false };
  }

  return {
    sessionId,
    hasLease: true,
    healthy: socketReachable,
    socketReachable,
    pidAlive: true,
    pid: owner.pid,
    socketPath: owner.socketPath,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
  };
}
