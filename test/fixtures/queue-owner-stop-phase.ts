import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpClient } from "../../src/acp/client.js";
import { runSessionQueueOwner } from "../../src/session/execution/queue-owner-runtime.js";
import { SessionQueueOwner } from "../../src/session/queue/ipc-server.js";
import { queueLockFilePath } from "../../src/session/queue/paths.js";
import { makeSessionRecord, writeSessionRecordFile } from "../runtime-test-helpers.js";

const [home, phase] = process.argv.slice(2);
assert(home && ["acquisition", "shutdown", "release"].includes(phase));
assert.equal(process.env.HOME, home);
assert.equal(typeof process.send, "function", "The fixture requires its owned parent IPC channel");
const sessionId = `stop-phase-${phase}`;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const counts = () =>
  Object.fromEntries(signals.map((signal) => [signal, process.listenerCount(signal)]));
const beforeCounts = counts();
const record = makeSessionRecord({
  acpxRecordId: sessionId,
  acpSessionId: sessionId,
  agentCommand: "unused-stop-phase-agent",
  agentArgv: [process.execPath, "--eval", "process.exit(99)"],
  cwd: home,
});
await writeSessionRecordFile(home, record);
const requestedLock = queueLockFilePath(sessionId, home);
await fs.mkdir(path.dirname(requestedLock), { recursive: true });
const canonicalLock = path.join(
  await fs.realpath(path.dirname(requestedLock)),
  path.basename(requestedLock),
);
const locks = new Set([requestedLock, canonicalLock]);
const guards = new Set([...locks].map((file) => `${file}.guard`));
async function present(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

let releaseGate: (() => void) | undefined;
let held = false;
let closeCalls = 0;
let leaseUnlinks = 0;
async function gate(): Promise<void> {
  assert(!held, "Only one owned phase is held per fixture");
  held = true;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const lease = JSON.parse(await fs.readFile(requestedLock, "utf8")) as {
    pid: number;
    sessionId: string;
  };
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.sessionId, sessionId);
  await send({
    type: "phase",
    phase,
    beforeCounts,
    counts: counts(),
    lease,
    guardPresent: await present(`${canonicalLock}.guard`),
  });
  await released;
  releaseGate = undefined;
}

process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object" || !("type" in raw)) {
    return;
  }
  if (raw.type === "release") {
    releaseGate?.();
    return;
  }
  if (raw.type === "probe" && "token" in raw && typeof raw.token === "number") {
    const token = raw.token;
    setImmediate(() => {
      void send({
        type: "probe",
        token,
        phase,
        held: Boolean(releaseGate),
        counts: counts(),
        closeCalls,
        leaseUnlinks,
      }).catch((error: unknown) => {
        process.stderr.write(String(error) + "\n");
        process.exitCode = 1;
      });
    });
  }
});

const rm = fs.rm;
const unlink = fs.unlink;
// Retain exact methods for restoration; the wrappers supply their receivers below.
// oxlint-disable-next-line typescript/unbound-method
const close = AcpClient.prototype.close;
// oxlint-disable-next-line typescript/unbound-method
const start = SessionQueueOwner.start;
fs.rm = async (...args: Parameters<typeof fs.rm>) => {
  if (phase === "acquisition" && !held && guards.has(path.resolve(String(args[0])))) {
    await gate();
  }
  return await rm(...args);
};
fs.unlink = async (...args: Parameters<typeof fs.unlink>) => {
  if (locks.has(path.resolve(String(args[0])))) {
    leaseUnlinks += 1;
    if (phase === "release" && !held) {
      await gate();
    }
  }
  return await unlink(...args);
};
AcpClient.prototype.close = async function (this: AcpClient): Promise<void> {
  closeCalls += 1;
  if (phase === "shutdown" && !held) {
    await gate();
  }
  await close.call(this);
};
SessionQueueOwner.start = async (...args: Parameters<typeof SessionQueueOwner.start>) => {
  const owner = await start.call(SessionQueueOwner, ...args);
  await send({ type: "ready", phase, beforeCounts, counts: counts() });
  return owner;
};

try {
  await runSessionQueueOwner({ sessionId, permissionMode: "deny-all", ttlMs: 0 });
  await send({
    type: "done",
    phase,
    beforeCounts,
    counts: counts(),
    closeCalls,
    leaseUnlinks,
    leasePresent: await present(requestedLock),
    guardPresent: await present(`${canonicalLock}.guard`),
  });
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack : error) + "\n");
  process.exitCode = 1;
} finally {
  fs.rm = rm;
  fs.unlink = unlink;
  AcpClient.prototype.close = close;
  SessionQueueOwner.start = start;
  process.disconnect?.();
}
