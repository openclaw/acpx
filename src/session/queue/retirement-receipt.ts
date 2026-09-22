import { includeProcessDescendants } from "../../acp/process-descendants.js";
import { QueueConnectionError } from "../../errors.js";
import {
  compareProcessBirthIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  readProcessTable,
  type ProcessBirthIdentity,
  type ProcessTableEntry,
} from "../../process-identity.js";

// The process-helper output cap does not bound accumulated, persisted witnesses.
// Refuse before signaling instead of truncating the only receipt for a survivor.
const MAX_RETIREMENT_MEMBERS = 4_096;
const MAX_RETIREMENT_BYTES = 1024 * 1024;

type ProcessWitness = { pid: number; processIdentity: ProcessBirthIdentity };
type RetirementOwner = {
  pid: number;
  ownerGeneration: number;
  processIdentity?: ProcessBirthIdentity;
};

export type QueueRetirementReceipt = {
  ownerGeneration: number;
  root: ProcessWitness;
  descendants: ProcessWitness[];
};

export function hasQueueRetirementReceipt(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "retirement");
}

function parseWitness(raw: unknown): ProcessWitness | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const processIdentity = parseProcessBirthIdentity(value.processIdentity);
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    processIdentity?.kind !== "windows-creation"
  ) {
    return undefined;
  }
  return { pid: value.pid, processIdentity };
}

export function parseQueueRetirementReceipt(
  raw: unknown,
  owner: RetirementOwner,
): QueueRetirementReceipt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const root = parseReceiptRoot(value, owner);
  if (!root) {
    return null;
  }
  const descendants = parseDescendants(value.descendants, root.pid);
  if (!descendants || Buffer.byteLength(JSON.stringify(raw)) > MAX_RETIREMENT_BYTES) {
    return null;
  }
  return { ownerGeneration: owner.ownerGeneration, root, descendants };
}

function parseReceiptRoot(
  value: Record<string, unknown>,
  owner: RetirementOwner,
): ProcessWitness | undefined {
  const root = parseWitness(value.root);
  if (
    !root ||
    root.pid !== owner.pid ||
    value.ownerGeneration !== owner.ownerGeneration ||
    compareProcessBirthIdentity(owner.processIdentity, root.processIdentity) !== "matching"
  ) {
    return undefined;
  }
  return root;
}

function parseDescendants(raw: unknown, rootPid: number): ProcessWitness[] | undefined {
  if (!Array.isArray(raw) || raw.length >= MAX_RETIREMENT_MEMBERS) {
    return undefined;
  }
  const pids = new Set([rootPid]);
  const witnesses: ProcessWitness[] = [];
  for (const value of raw) {
    const witness = parseWitness(value);
    if (!witness || pids.has(witness.pid)) {
      return undefined;
    }
    pids.add(witness.pid);
    witnesses.push(witness);
  }
  return witnesses;
}

export function queueRetirementIncomplete(): QueueConnectionError {
  return new QueueConnectionError(
    "Queue-owner descendant cleanup is incomplete or unverified. Its lease was retained. Retry cleanup with updated clients and process-query access; do not remove the lease while recorded processes may remain.",
    { detailCode: "QUEUE_OWNER_RETIREMENT_INCOMPLETE", origin: "queue", retryable: true },
  );
}

export function retirementTimeRemaining(deadline: number, maximumMs = 2_000): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw queueRetirementIncomplete();
  }
  return Math.min(maximumMs, remaining);
}

export async function captureQueueRetirementReceipt(
  owner: RetirementOwner,
  previous: QueueRetirementReceipt | undefined,
  rootRunning: boolean,
  deadline: number,
): Promise<QueueRetirementReceipt> {
  const root = parseWitness({ pid: owner.pid, processIdentity: owner.processIdentity });
  if (!root || process.platform !== "win32") {
    throw queueRetirementIncomplete();
  }
  const table = await readProcessTable(retirementTimeRemaining(deadline)).catch(() => {
    throw queueRetirementIncomplete();
  });
  const saved = unsettledSnapshotWitnesses(table, previous ? previous.descendants : []);
  const owned = matchingSnapshotPids(table, rootRunning ? [root, ...saved] : saved);
  if (rootRunning && !owned.has(root.pid)) {
    throw queueRetirementIncomplete();
  }
  table.delete(1);
  table.delete(process.pid);
  includeProcessDescendants(table, owned);
  owned.delete(root.pid);
  const receipt = {
    ownerGeneration: owner.ownerGeneration,
    root,
    descendants: mergeSnapshotDescendants(table, owned, saved),
  };
  if (!parseQueueRetirementReceipt(receipt, owner)) {
    throw queueRetirementIncomplete();
  }
  return receipt;
}

function unsettledSnapshotWitnesses(
  table: Map<number, ProcessTableEntry>,
  witnesses: ProcessWitness[],
): ProcessWitness[] {
  // A different canonical birth proves the saved incarnation is gone. Persist
  // that progress before signaling so live reused PIDs cannot starve later members.
  return witnesses.filter((witness) => {
    const observed = table.get(witness.pid);
    return (
      !observed ||
      compareProcessBirthIdentity(witness.processIdentity, observed.birth) !== "different"
    );
  });
}

function matchingSnapshotPids(
  table: Map<number, ProcessTableEntry>,
  witnesses: ProcessWitness[],
): Set<number> {
  const owned = new Set<number>();
  for (const witness of witnesses) {
    const observed = table.get(witness.pid);
    if (
      observed &&
      compareProcessBirthIdentity(witness.processIdentity, observed.birth) === "matching"
    ) {
      owned.add(witness.pid);
    }
  }
  return owned;
}

function mergeSnapshotDescendants(
  table: Map<number, ProcessTableEntry>,
  owned: Set<number>,
  saved: ProcessWitness[],
): ProcessWitness[] {
  const descendants = new Map(saved.map((witness) => [witness.pid, witness]));
  for (const pid of owned) {
    const observed = table.get(pid);
    if (observed) {
      descendants.set(pid, { pid, processIdentity: observed.birth });
    }
  }
  return [...descendants.values()];
}

export async function observeRetirementWitness(witness: ProcessWitness, deadline: number) {
  if (witness.pid === process.pid) {
    throw queueRetirementIncomplete();
  }
  return await observeProcessIncarnation(
    witness.pid,
    witness.processIdentity,
    retirementTimeRemaining(deadline),
  );
}

export async function assertQueueRetirementComplete(
  receipt: QueueRetirementReceipt | null | undefined,
  deadline: number,
): Promise<void> {
  if (receipt === null) {
    throw queueRetirementIncomplete();
  }
  for (const witness of receipt?.descendants ?? []) {
    if ((await observeRetirementWitness(witness, deadline)) !== "gone") {
      throw queueRetirementIncomplete();
    }
  }
}
