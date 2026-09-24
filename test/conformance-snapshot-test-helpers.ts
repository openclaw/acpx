import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./conformance-test-helpers.js";
import type { Receipt } from "./fixtures/conformance-retirement.js";

const QUERY_BUDGET_WITNESS_BODY = String.raw`const { AsyncLocalStorage } = await import("node:async_hooks");
const { syncBuiltinESMExports } = await import("node:module");
const { setTimeout: schedule } = await import("node:timers");
const { default: childProcess } = await import("node:child_process");
const context = new AsyncLocalStorage();
let nextPhase = 0;
let nextSnapshot = 0;
let nextHelper = 0;

const realExecFile = childProcess.execFile;
childProcess.execFile = function (...args) {
  const scope = context.getStore();
  const argv = args[1];
  const callback = args.at(-1);
  const linuxTable = process.platform === "linux" && args[0] === process.execPath &&
    Array.isArray(argv) && argv[0] === "--input-type=commonjs" && argv[1] === "-e" &&
    argv[3] === "all" && argv[4] === String(process.pid);
  const posixTable = process.platform === "darwin" && args[0] === "ps" &&
    Array.isArray(argv) && argv.includes("-e") && argv.includes("pid=,ppid=,pgid=,stat=,lstart=");
  if (!scope?.snapshot || (!linuxTable && !posixTable) || typeof callback !== "function") {
    return Reflect.apply(realExecFile, this, args);
  }
  const helper = ++nextHelper;
  const started = performance.now();
  const forwarded = [...args];
  forwarded[forwarded.length - 1] = function (...result) {
    const receiver = this;
    const nativeAt = performance.now();
    record({ kind: "helper-native-callback", helper, ...scope, elapsedMs: nativeAt - started,
      errorCode: result[0]?.code ?? null, errorMessage: result[0]?.message ?? null });
    schedule(() => {
      record({ kind: "helper-deliver-callback", helper, ...scope,
        elapsedMs: performance.now() - started, delayMs: performance.now() - nativeAt });
      Reflect.apply(callback, receiver, result); // Exact original callback values/receiver.
    }, 350);
  };
  const child = Reflect.apply(realExecFile, this, forwarded);
  record({ kind: "helper-start", helper, helperPid: child.pid, ...scope, configuredDelayMs: 350 });
  child.once("exit", (code, signal) => record({ kind: "helper-exit", helper, code, signal, ...scope }));
  return child; // Exact real ChildProcess; no replacement result or synthetic snapshot.
};
syncBuiltinESMExports();

const { AdapterLifetime } = await import(lifetimeSourceUrl);
const { ProcessDescendants } = await import(descendantsSourceUrl);
const running = child => child.exitCode == null && child.signalCode == null;
const realWait = AdapterLifetime.prototype.waitForRetirement;
if (typeof realWait !== "function") throw new Error("Missing lifetime wait seam");
AdapterLifetime.prototype.waitForRetirement = function (waitMs, deadline) {
  const scope = { phase: ++nextPhase, waitMs, deadline, adapterPid: this.child.pid };
  return context.run(scope, () => {
    record({ kind: "phase-enter", ...scope, overallRemainingMs: deadline - performance.now(), running: running(this.child) });
    const pending = Reflect.apply(realWait, this, [waitMs, deadline]);
    void pending.then(actual => record({ kind: "phase-settled", ...scope, actual }),
      error => record({ kind: "phase-threw", ...scope, error: String(error) }));
    return pending;
  });
};

const realSnapshot = ProcessDescendants.prototype.readSnapshot;
if (typeof realSnapshot !== "function") throw new Error("Missing descendant snapshot seam");
ProcessDescendants.prototype.readSnapshot = function (timeoutMs) {
  const parent = context.getStore() ?? {};
  const scope = { ...parent, snapshot: ++nextSnapshot, timeoutMs, adapterPid: this.child.pid };
  return context.run(scope, () => {
    record({ kind: "snapshot-enter", ...scope, running: running(this.child),
      exitAdmissionAvailable: this.captureGroupAfterExit,
      overallRemainingMs: typeof scope.deadline === "number" ? scope.deadline - performance.now() : null });
    const pending = Reflect.apply(realSnapshot, this, [timeoutMs]);
    void pending.then(actual => record({ kind: "snapshot-settled", ...scope, actual,
      running: running(this.child), tracked: this.hasTrackedProcesses(), unresolved: this.hasUnresolvedOwnership() }),
      error => record({ kind: "snapshot-threw", ...scope, error: String(error) }));
    return pending;
  });
};
record({ kind: "budget-witness-installed", delayMs: 350 });
`;

export async function writeSlowTablePreload(root: string, nonce: string): Promise<string> {
  const file = path.join(root, "slow-table-preload.mjs");
  const trace = path.join(root, "slow-table.ndjson");
  const body = QUERY_BUDGET_WITNESS_BODY;
  await fs.writeFile(
    file,
    `
import { appendFileSync } from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  if (path.resolve(process.argv[1] ?? "") !== ${JSON.stringify(path.join(REPO_ROOT, "conformance/runner/run.ts"))}) {
    throw new Error("Slow-table preload attached to an unexpected entry point");
  }
  let sequence = 0;
  const record = entry => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
    nonce: ${JSON.stringify(nonce)}, pid: process.pid, sequence: ++sequence, ...entry,
  }) + "\\n");
  const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
  register({ tsconfig: ${JSON.stringify(path.join(REPO_ROOT, "tsconfig.json"))} });
  const lifetimeSourceUrl = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "conformance/runner/adapter-lifetime.ts")).href)};
  const descendantsSourceUrl = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "src/acp/process-descendants.ts")).href)};
  ${body}
}
`,
    "utf8",
  );
  return pathToFileURL(file).href;
}

type BudgetRow = {
  nonce: string;
  pid: number;
  sequence: number;
  kind: string;
  phase?: number;
  snapshot?: number;
  helper?: number;
  helperPid?: number;
  waitMs?: number;
  timeoutMs?: number;
  overallRemainingMs?: number;
  running?: boolean;
  exitAdmissionAvailable?: boolean;
  actual?: boolean;
  unresolved?: boolean;
  configuredDelayMs?: number;
  delayMs?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  code?: number | null;
  signal?: string | null;
};

export async function verifySlowTableBudget(
  root: string,
  nonce: string,
  runnerPid: number | undefined,
  peerRows: Receipt[],
): Promise<BudgetRow[]> {
  const budgetRows = (await fs.readFile(path.join(root, "slow-table.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as BudgetRow);
  assert.equal(budgetRows.filter((row) => row.kind === "budget-witness-installed").length, 1);
  for (const row of budgetRows) {
    assert.equal(row.nonce, nonce);
    assert.equal(row.pid, runnerPid, "only the runner receives verification latency");
  }
  const eofPhase = budgetRows.find((row) => row.kind === "phase-enter" && row.waitMs === 250);
  assert.ok(eofPhase, "actual EOF retirement phase must execute");
  const critical = budgetRows.find(
    (row) => row.kind === "snapshot-enter" && row.phase === eofPhase.phase,
  );
  assert.ok(critical, "the actual phase must perform its ownership observation");
  assert.equal(critical.running, false, "wait for native direct-child exit before snapshot");
  assert.equal(critical.exitAdmissionAvailable, true, "exercise the one-shot admission snapshot");
  assert.ok((critical.overallRemainingMs ?? 0) > 1_000);
  assert.equal(critical.timeoutMs, 1_000, "the 250ms grace must not shrink the query budget");
  const helperStart = budgetRows.find(
    (row) => row.kind === "helper-start" && row.snapshot === critical.snapshot,
  );
  assert.ok(helperStart, "the native process table helper must actually run");
  assert.equal(helperStart.configuredDelayMs, 350);
  const callback = budgetRows.find(
    (row) => row.kind === "helper-native-callback" && row.helper === helperStart.helper,
  );
  const delivered = budgetRows.find(
    (row) => row.kind === "helper-deliver-callback" && row.helper === helperStart.helper,
  );
  const helperExit = budgetRows.find(
    (row) => row.kind === "helper-exit" && row.helper === helperStart.helper,
  );
  assert.ok(callback && delivered && helperExit);
  assert.equal(callback.errorCode, null);
  assert.equal(callback.errorMessage, null);
  assert.equal(helperExit.code, 0);
  assert.equal(helperExit.signal, null);
  assert.ok((delivered.delayMs ?? 0) > 250, "native callback must be withheld beyond old grace");
  const result = budgetRows.find(
    (row) => row.kind === "snapshot-settled" && row.snapshot === critical.snapshot,
  );
  assert.equal(
    result?.actual,
    true,
    "require actual successful source snapshot, not synthetic success",
  );
  assert.equal(result?.unresolved, false);
  assert.ok(peerRows.some((row) => row.kind === "ordinary-eof-complete"));
  assert.equal(
    peerRows.some((row) => row.kind === "sigterm"),
    false,
    "peer should exit from ordinary EOF",
  );
  return budgetRows;
}
