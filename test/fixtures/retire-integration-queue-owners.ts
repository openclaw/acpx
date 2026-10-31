import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { observeProcessIncarnation, probeProcessIdentity } from "../../src/process-identity.js";
import { readSessionRecord } from "../../src/session/persistence.js";
import {
  readQueueOwnerRecord,
  terminateQueueOwnerForSession,
} from "../../src/session/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath } from "../../src/session/queue/paths.js";

// Run in a child with the fixture HOME: queue retirement resolves os.homedir().
// Changing the test runner's HOME would redirect unrelated in-flight work.
const queueDirectory = queueBaseDir();
const lockFiles = (await fs.readdir(queueDirectory)).filter((file) => file.endsWith(".lock"));
for (const file of lockFiles) {
  const lockPath = path.join(queueDirectory, file);
  const payload = await fs.readFile(lockPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (payload === undefined) {
    continue;
  }
  const raw = JSON.parse(payload) as { sessionId?: unknown } | null;
  assert.ok(typeof raw?.sessionId === "string", "Invalid fixture queue lease session ID");
  const sessionId = raw.sessionId;
  assert.equal(lockPath, queueLockFilePath(sessionId), "Fixture queue lease path mismatch");
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    // A naturally expiring owner may remove its lease between the two reads.
    assert.equal(await fs.stat(lockPath).then(() => true, missingFile), false);
    continue;
  }
  assert.ok(owner.processIdentity, "Fixture queue owner has no verified birth identity");
  const record = await readSessionRecord(sessionId);
  assert.equal(record?.acpxRecordId, sessionId, "Fixture queue owner has no matching session");
  const agentPid = record?.pid;
  const agent = agentPid === undefined ? undefined : await probeProcessIdentity(agentPid);
  assert.notEqual(agent?.state, "unknown", "Fixture agent birth identity is unknown");

  await terminateQueueOwnerForSession(sessionId, owner);
  // Retirement may return after a lease replacement without proving this owner
  // exited. Neither that return nor a missing lock permits HOME removal alone.
  assert.equal(
    await observeProcessIncarnation(owner.pid, owner.processIdentity),
    "gone",
    "Fixture queue owner survived retirement",
  );
  if (agent?.state === "alive" && agentPid !== undefined) {
    // This is a passive witness for the recorded agent, never signal authority
    // for a saved PID or a claim about arbitrary grandchildren.
    assert.equal(
      await observeProcessIncarnation(agentPid, agent.identity),
      "gone",
      "Fixture agent survived queue owner retirement",
    );
  }
}
assert.deepEqual(
  (await fs.readdir(queueDirectory)).filter((file) => file.endsWith(".lock")),
  [],
  "Fixture queue leases remain after retirement",
);

function missingFile(error: NodeJS.ErrnoException): false {
  if (error.code === "ENOENT") {
    return false;
  }
  throw error;
}
