import { connectToQueueOwner } from "./ipc-transport.js";
import { readQueueOwnerRecord, readQueueOwnerStatus } from "./lease-store.js";

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

export async function probeQueueOwnerHealth(sessionId: string): Promise<QueueOwnerHealth> {
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

  const owner = await readQueueOwnerStatus(sessionId);
  if (!owner) {
    return {
      sessionId,
      hasLease: false,
      healthy: false,
      socketReachable: false,
      pidAlive: false,
    };
  }

  const pidAlive = owner.alive;
  let socketReachable = false;
  try {
    const socket = await connectToQueueOwner(ownerRecord, 2);
    if (socket) {
      socketReachable = true;
      if (!socket.destroyed) {
        socket.end();
      }
    }
  } catch {
    socketReachable = false;
  }

  return {
    sessionId,
    hasLease: true,
    healthy: socketReachable,
    socketReachable,
    pidAlive,
    pid: owner.pid,
    socketPath: owner.socketPath,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
  };
}
