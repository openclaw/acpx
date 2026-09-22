import assert from "node:assert/strict";
import childProcess, {
  spawn,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  compareProcessBirthIdentity,
  observeProcessIncarnation,
  probeProcessIdentity,
  readProcessTable,
  type ProcessBirthIdentity,
  type ProcessTableEntry,
} from "../../src/process-identity.js";
import {
  readQueueOwnerRecord,
  terminateQueueOwnerForSession,
} from "../../src/session/queue/lease-store.js";
import { queueLockFilePath } from "../../src/session/queue/paths.js";

type Witness = { pid: number; processIdentity: ProcessBirthIdentity };
export type RetirerMode =
  | "partial"
  | "partial-settlement"
  | "success-survivor"
  | "success-stalled"
  | "retry"
  | "slow-retry"
  | "query-failure"
  | "write-failure";
type WorkerReport = {
  code?: string | number;
  taskkillCalls: number;
  receiptWitnesses: Witness[];
  publishedReceiptWitnesses?: Witness[];
};

function reachesFixtureRoot(
  entry: ProcessTableEntry,
  table: Map<number, ProcessTableEntry>,
  rootPid: number,
): boolean {
  const seen = new Set<number>();
  let current = entry;
  while (current.pid !== rootPid) {
    if (seen.has(current.pid)) {
      return false;
    }
    seen.add(current.pid);
    const parent = table.get(current.parentPid);
    if (
      parent?.birth.kind !== "windows-creation" ||
      current.birth.kind !== "windows-creation" ||
      parent.birth.value > current.birth.value
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

async function observeFixtureTree(root: Witness): Promise<Witness[]> {
  const table = await readProcessTable(2_000);
  const observed = table.get(root.pid);
  assert(
    observed && compareProcessBirthIdentity(root.processIdentity, observed.birth) === "matching",
  );
  // A detached Windows Node actor can also create a console host. Derive the
  // complete expected tree independently, without the production selector.
  return [...table.values()]
    .filter((entry) => reachesFixtureRoot(entry, table, root.pid))
    .map((entry) => ({ pid: entry.pid, processIdentity: entry.birth }));
}

function fixtureCleanupWitnesses(known: Witness[], expected: Witness[]): Witness[] {
  return [
    ...new Map(
      [...known, ...expected].map((witness) => [JSON.stringify(witness), witness]),
    ).values(),
  ];
}

async function settleFixtureStartup(
  child: ChildProcess,
  closed: Promise<unknown>,
  witnesses: Witness[],
): Promise<void> {
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    if (child.connected) {
      const stopped = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.send("stop");
      await stopped;
    }
  } finally {
    results = await Promise.allSettled([stopWitnesses(witnesses), closed]);
  }
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

export async function startWitnessedTree(leafCount = 1) {
  // All fixtures expire independently, including a detached leaf whose parent died.
  const lifetime = "setTimeout(() => process.exit(0), 45_000)";
  const bridgeSource = `
    const {spawn} = require('node:child_process');
    const leaves = Array.from({length: ${leafCount}}, () => spawn(process.execPath, ['-e', ${JSON.stringify(lifetime)}], {stdio:'ignore', detached:true}));
    Promise.all(leaves.map(leaf => new Promise(resolve => leaf.once('spawn', resolve))))
      .then(() => process.send([process.pid, ...leaves.map(leaf => leaf.pid)]));
    process.on('message', async message => {
      if (message !== 'stop') return;
      await Promise.all(leaves.map(leaf => new Promise(resolve => {
        if (leaf.exitCode !== null || leaf.signalCode !== null) return resolve();
        leaf.once('close', resolve); leaf.kill('SIGKILL');
      })));
      process.exit(0);
    });
    ${lifetime};
  `;
  const rootSource = `
    const {spawn} = require('node:child_process');
    const bridge = spawn(process.execPath, ['-e', ${JSON.stringify(bridgeSource)}], {stdio:['ignore','ignore','ignore','ipc']});
    bridge.once('message', pids => process.send([process.pid, ...pids]));
    process.on('message', message => {
      if (message !== 'stop') return;
      bridge.once('close', () => process.exit(0)); bridge.send('stop');
    });
    ${lifetime};
  `;
  const child = spawn(process.execPath, ["-e", rootSource], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true,
  });
  const closed = once(child, "close");
  const witnesses: Witness[] = [];
  let expectedWitnesses: Witness[] = [];
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    assert(Array.isArray(message) && message.length === leafCount + 2);
    for (const pid of message as number[]) {
      assert(Number.isSafeInteger(pid) && pid > 1);
      const probe = await probeProcessIdentity(pid);
      assert(probe.state === "alive");
      witnesses.push({ pid, processIdentity: probe.identity });
    }
    expectedWitnesses = await observeFixtureTree(witnesses[0]);
    for (const witness of witnesses) {
      const expected = expectedWitnesses.find((entry) => entry.pid === witness.pid);
      assert(
        expected &&
          compareProcessBirthIdentity(witness.processIdentity, expected.processIdentity) ===
            "matching",
      );
    }
    return { child, closed, witnesses, expectedWitnesses };
  } catch (error) {
    // Setup can fail before births are known. Ask each spawning process to join
    // its own child handles instead of signaling an unverified numeric PID.
    await settleFixtureStartup(
      child,
      closed,
      fixtureCleanupWitnesses(witnesses, expectedWitnesses),
    );
    throw error;
  }
}

export async function witnessStates(witnesses: Witness[]) {
  return await Promise.all(
    witnesses.map((witness) => observeProcessIncarnation(witness.pid, witness.processIdentity)),
  );
}

export async function stopWitnesses(witnesses: Witness[]): Promise<void> {
  for (const witness of witnesses.toReversed()) {
    const state = await observeProcessIncarnation(witness.pid, witness.processIdentity);
    assert.notEqual(state, "unknown", "fixture cleanup needs verified custody");
    if (state === "matching") {
      process.kill(witness.pid, "SIGKILL");
    }
  }
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if ((await witnessStates(witnesses)).every((state) => state === "gone")) {
      return;
    }
    await delay(50);
  }
  assert.deepEqual(
    await witnessStates(witnesses),
    witnesses.map(() => "gone"),
  );
}

export async function runRetirer(mode: RetirerMode, sessionId: string): Promise<WorkerReport> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, sessionId], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-16_384);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as WorkerReport;
}

function savedReceiptWitnesses(sessionId: string): Witness[] {
  const raw = JSON.parse(readFileSync(queueLockFilePath(sessionId), "utf8")) as {
    retirement?: { descendants?: Witness[] };
  };
  return raw.retirement?.descendants ?? [];
}

export async function settleRetirerHelpers(
  helpers: { child: ChildProcess; closed: Promise<void> }[],
): Promise<void> {
  await Promise.all(
    helpers.map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }),
  );
}

async function runWorker(mode: RetirerMode, sessionId: string): Promise<void> {
  const originalExecFile = childProcess.execFile.bind(childProcess);
  const rename = fs.rename.bind(fs);
  const rm = fs.rm.bind(fs);
  const owner = await readQueueOwnerRecord(sessionId);
  assert(owner);
  const report: WorkerReport = { taskkillCalls: 0, receiptWitnesses: [] };
  const helpers: { child: ChildProcess; closed: Promise<void> }[] = [];
  let released = false;
  let observedTime = performance.now();
  if (mode === "slow-retry") {
    Object.defineProperty(performance, "now", { value: () => observedTime });
  }
  childProcess.execFile = ((
    command: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const taskkill = path.win32.basename(command).toLowerCase() === "taskkill.exe";
    if (taskkill) {
      report.taskkillCalls += 1;
      report.receiptWitnesses = savedReceiptWitnesses(sessionId);
    }
    let substitute: string | undefined;
    if (
      taskkill &&
      (mode === "partial" || mode === "partial-settlement" || mode === "success-survivor")
    ) {
      substitute = `process.kill(${owner.pid}); process.exit(${mode === "success-survivor" ? 0 : 23})`;
    } else if (taskkill && mode === "success-stalled") {
      substitute = "process.exit(0)";
    } else if (
      mode === "query-failure" &&
      path.win32.basename(command).toLowerCase() === "powershell.exe"
    ) {
      substitute = "process.exit(29)";
    }
    const queriedPid = /-Filter 'ProcessId = (\d+)'/.exec(args.at(-1) ?? "")?.[1];
    const countedQuery =
      mode === "slow-retry" &&
      path.win32.basename(command).toLowerCase() === "powershell.exe" &&
      Number(queriedPid) !== process.pid;
    const observeDuration = (error: Error | null, stdout: string, stderr: string) => {
      // Native CIM still determines identity. Charge its foreign observations
      // near the query ceiling without host-clock changes or timing-sensitive sleeps.
      if (countedQuery) {
        observedTime += 1_900;
      }
      callback(error, stdout, stderr);
    };
    const helper =
      substitute === undefined
        ? originalExecFile(command, [...args], options, observeDuration)
        : originalExecFile(process.execPath, ["-e", substitute], options, observeDuration);
    helpers.push({
      child: helper,
      closed: new Promise((resolve) => {
        helper.once("close", () => resolve());
      }),
    });
    return helper;
  }) as typeof childProcess.execFile;
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (mode === "write-failure" && args[1] === queueLockFilePath(sessionId)) {
      throw Object.assign(new Error("injected receipt publication failure"), { code: "EIO" });
    }
    await rename(...args);
    if (args[1] === queueLockFilePath(sessionId)) {
      report.publishedReceiptWitnesses = savedReceiptWitnesses(sessionId);
    }
  };
  fs.rm = async (...args: Parameters<typeof fs.rm>) => {
    await rm(...args);
    if (mode === "partial-settlement" && !released && String(args[0]).endsWith(".guard")) {
      released = true;
      throw new Error("injected guard acknowledgement failure");
    }
  };
  syncBuiltinESMExports();
  if (mode === "success-stalled") {
    let now = Date.now();
    Date.now = () => {
      now -= 60_000;
      return now;
    };
  }
  try {
    try {
      await terminateQueueOwnerForSession(sessionId, undefined, mode === "query-failure");
    } catch (error) {
      const failure = error as { detailCode?: string; code?: string | number };
      report.code = failure.detailCode ?? failure.code ?? "unexpected";
    }
  } finally {
    // Join every helper directly; a failed Node24 assertion need not print after hooks.
    await settleRetirerHelpers(helpers);
  }
  process.stdout.write(JSON.stringify(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWorker(process.argv[2] as RetirerMode, process.argv[3]);
}
