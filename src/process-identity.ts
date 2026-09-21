import path from "node:path";
import { runTimedExecFile } from "./acp/client-process.js";
import { isProcessDefinitelyDead } from "./process-liveness.js";

type TimestampIdentity = {
  kind: "posix-lstart" | "windows-creation";
  value: string;
};

type LinuxProcessScope = {
  bootId: string;
  pidNamespace: string;
  timeNamespace: string;
};

type LinuxProcessIdentity = LinuxProcessScope & { kind: "linux-proc"; startTicks: string };

export type ProcessBirthIdentity = TimestampIdentity | LinuxProcessIdentity;
export type ProcessIdentityComparison = "matching" | "different" | "unknown";
export type ProcessIncarnation = "matching" | "gone" | "unknown";

export type ProcessIdentityProbe =
  | { state: "alive"; identity: ProcessBirthIdentity }
  | { state: "dead" }
  | { state: "unknown" };

export type ProcessTableEntry = {
  pid: number;
  parentPid: number;
  groupPid: number;
  birth: string;
};

const IDENTITY_QUERY_TIMEOUT_MS = 2_000;
// A single builtin-only helper bounds proc I/O without leaving uncancellable
// readlink work in the caller after timeout. Its scope must match the observer,
// including when a parent configured a different time namespace for children.
const LINUX_PROCESS_QUERY = `
  const fs = require('node:fs/promises');
  const [targetPid, observerPid] = process.argv.slice(1);
  if (process.ppid !== Number(observerPid)) process.exit(1);
  const timeNamespace = (pid) => fs.readlink('/proc/' + pid + '/ns/time').catch((error) => {
    if (error.code === 'ENOENT') return 'unsupported';
    throw error;
  });
  Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readlink('/proc/self/ns/pid'),
    timeNamespace('self'),
    fs.readlink('/proc/' + observerPid + '/ns/pid'),
    timeNamespace(observerPid),
    fs.readFile('/proc/self/stat', 'utf8'),
    fs.readFile('/proc/' + targetPid + '/stat', 'utf8').catch(() => null),
  ]).then(([bootId, pidNamespace, timeNamespace, observerPidNamespace,
    observerTimeNamespace, selfStat, targetStat]) => {
    process.stdout.write(JSON.stringify({bootId: bootId.trim(), pidNamespace,
      timeNamespace, observerPidNamespace, observerTimeNamespace,
      helperPid: process.pid, selfStat, targetStat}));
  }).catch(() => { process.exitCode = 1; });
`;
const POSIX_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
let ownIdentity: ProcessBirthIdentity | undefined;
let ownIdentityPending: Promise<ProcessBirthIdentity | undefined> | undefined;

export function parseProcessBirthIdentity(raw: unknown): ProcessBirthIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const identity = raw as Record<string, unknown>;
  if (identity.kind === "linux-proc") {
    return parseLinuxIdentity(identity);
  }
  if (identity.kind !== "posix-lstart" && identity.kind !== "windows-creation") {
    return undefined;
  }
  if (!isCanonicalBirth(identity.value, identity.kind)) {
    return undefined;
  }
  return { kind: identity.kind, value: identity.value };
}

function isCanonicalBirth(value: unknown, kind: TimestampIdentity["kind"]): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const canonical = new Date(value).toISOString();
  return (
    canonical.slice(0, 19) === value.slice(0, 19) &&
    (kind === "posix-lstart"
      ? value === canonical && value.endsWith(".000Z")
      : /\.\d{7}Z$/.test(value))
  );
}

function parseLinuxScope(raw: Record<string, unknown>): LinuxProcessScope | undefined {
  const { bootId, pidNamespace, timeNamespace } = raw;
  if (
    typeof bootId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId) ||
    typeof pidNamespace !== "string" ||
    !/^pid:\[[1-9]\d*\]$/.test(pidNamespace) ||
    !isTimeNamespace(timeNamespace)
  ) {
    return undefined;
  }
  return { bootId, pidNamespace, timeNamespace };
}

function isTimeNamespace(value: unknown): value is string {
  // Kernels without CONFIG_TIME_NS have no /proc/PID/ns/time entry. The helper
  // recognizes only ENOENT, not denied access, as this explicit shared scope.
  return (
    typeof value === "string" && (value === "unsupported" || /^time:\[[1-9]\d*\]$/.test(value))
  );
}

function isStartTicks(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

function parseLinuxIdentity(raw: Record<string, unknown>): LinuxProcessIdentity | undefined {
  const scope = parseLinuxScope(raw);
  if (!scope || !isStartTicks(raw.startTicks)) {
    return undefined;
  }
  return { kind: "linux-proc", ...scope, startTicks: raw.startTicks };
}

function compareLinuxScope(
  expected: LinuxProcessScope,
  observed: LinuxProcessScope,
): ProcessIdentityComparison {
  // Queue homes are local to one machine. A prior boot cannot retain a live
  // owner; a different namespace in this boot cannot establish its absence.
  if (expected.bootId !== observed.bootId) {
    return "different";
  }
  if (
    expected.pidNamespace !== observed.pidNamespace ||
    expected.timeNamespace !== observed.timeNamespace
  ) {
    return "unknown";
  }
  return "matching";
}

function compareLinuxIdentity(
  expected: LinuxProcessIdentity,
  observed: LinuxProcessIdentity,
): ProcessIdentityComparison {
  const scope = compareLinuxScope(expected, observed);
  return scope === "matching"
    ? expected.startTicks === observed.startTicks
      ? "matching"
      : "different"
    : scope;
}

export function compareProcessBirthIdentity(
  expected: ProcessBirthIdentity | undefined,
  observed: ProcessBirthIdentity,
): ProcessIdentityComparison {
  if (!expected || expected.kind !== observed.kind) {
    return "unknown";
  }
  if (expected.kind === "linux-proc" && observed.kind === "linux-proc") {
    return compareLinuxIdentity(expected, observed);
  }
  if ("value" in expected && "value" in observed) {
    return expected.value === observed.value ? "matching" : "different";
  }
  return "unknown";
}

function parseLinuxStat(raw: unknown): { pid: number; startTicks: string } | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const prefix = /^(\d+) \(/.exec(raw);
  const close = raw.lastIndexOf(")");
  if (!prefix || close < 0) {
    return undefined;
  }
  const pid = Number(prefix[1]);
  // comm may contain spaces, newlines and ')'; field 22 follows its final ')'.
  const fields = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (!isPositivePid(pid) || !isStartTicks(startTicks) || !/^[RSDTtKWPI]$/.test(fields[0] ?? "")) {
    return undefined;
  }
  return { pid, startTicks };
}

async function readLinuxObservation(
  pid: number,
  timeoutMs: number,
): Promise<{ scope: LinuxProcessScope; identity?: LinuxProcessIdentity } | undefined> {
  const output = await runTimedExecFile(
    process.execPath,
    ["--input-type=commonjs", "-e", LINUX_PROCESS_QUERY, String(pid), String(process.pid)],
    { timeoutMs, maxBufferBytes: 8_192, env: { ...process.env, NODE_OPTIONS: "" } },
  );
  const raw = JSON.parse(output) as Record<string, unknown>;
  const scope = parseLinuxScope(raw);
  const self = parseLinuxStat(raw.selfStat);
  if (
    !scope ||
    !self ||
    self.pid !== raw.helperPid ||
    scope.pidNamespace !== raw.observerPidNamespace ||
    scope.timeNamespace !== raw.observerTimeNamespace
  ) {
    return undefined;
  }
  const target = parseLinuxStat(raw.targetStat);
  return {
    scope,
    ...(target?.pid === pid
      ? { identity: { kind: "linux-proc", ...scope, startTicks: target.startTicks } as const }
      : {}),
  };
}

function isPositivePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows system directory is unavailable");
  }
  // A bare executable name searches the project directory before PATH on Windows.
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsProcessQuery(pid: number | undefined): string {
  const filter = pid === undefined ? "" : ` -Filter 'ProcessId = ${pid}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate${filter} | ForEach-Object {`,
    "if ($null -ne $_.CreationDate) {",
    "'{0} {1} 0 S {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o')",
    "}",
    "}",
  ].join("\n");
}

function posixBirth(value: string): string | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const month = POSIX_MONTHS.indexOf(match[1]);
  if (month < 0) {
    return undefined;
  }
  // lstart has one-second precision. Explicit UTC conversion keeps identities
  // stable across callers' timezones and descendant group-exit comparisons.
  const valueUtc = `${match[6]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[3]}:${match[4]}:${match[5]}.000Z`;
  return isCanonicalBirth(valueUtc, "posix-lstart") ? valueUtc : undefined;
}

function parseProcessTable(output: string): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[4].startsWith("Z")) {
      continue;
    }
    const pid = Number(match[1]);
    const birth = processTableBirth(match[5]);
    if (Number.isSafeInteger(pid) && pid > 0 && birth) {
      table.set(pid, { pid, parentPid: Number(match[2]), groupPid: Number(match[3]), birth });
    }
  }
  return table;
}

function processTableBirth(value: string): string | undefined {
  if (process.platform !== "win32") {
    return posixBirth(value);
  }
  return isCanonicalBirth(value, "windows-creation") ? value : undefined;
}

export async function readProcessTable(
  timeoutMs: number,
  pid?: number,
): Promise<Map<number, ProcessTableEntry>> {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("Process identity requires a positive PID");
  }
  if (process.platform === "win32") {
    const output = await runTimedExecFile(
      windowsPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessQuery(pid)],
      { timeoutMs, windowsHide: true },
    );
    return parseProcessTable(output);
  }
  const selection = pid === undefined ? ["-e"] : ["-p", String(pid)];
  const output = await runTimedExecFile(
    "ps",
    [...selection, "-o", "pid=,ppid=,pgid=,stat=,lstart="],
    {
      timeoutMs,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  );
  return parseProcessTable(output);
}

export async function probeProcessIdentity(
  pid: number,
  timeoutMs = IDENTITY_QUERY_TIMEOUT_MS,
): Promise<ProcessIdentityProbe> {
  if (!isPositivePid(pid)) {
    return { state: "unknown" };
  }
  if (isProcessDefinitelyDead(pid)) {
    return { state: "dead" };
  }
  try {
    const identity = await readNativeIdentity(pid, timeoutMs);
    if (identity) {
      return {
        state: "alive",
        identity,
      };
    }
  } catch {
    // Query failure and missing rows are not proof that a PID is safe to reclaim.
  }
  return { state: isProcessDefinitelyDead(pid) ? "dead" : "unknown" };
}

async function readNativeIdentity(
  pid: number,
  timeoutMs: number,
): Promise<ProcessBirthIdentity | undefined> {
  if (process.platform === "linux") {
    return (await readLinuxObservation(pid, timeoutMs))?.identity;
  }
  const entry = (await readProcessTable(timeoutMs, pid)).get(pid);
  return entry ? processBirthIdentity(entry.birth) : undefined;
}

function processBirthIdentity(value: string): TimestampIdentity {
  return { kind: process.platform === "win32" ? "windows-creation" : "posix-lstart", value };
}

function nativeIdentityKind(): ProcessBirthIdentity["kind"] {
  if (process.platform === "linux") {
    return "linux-proc";
  }
  return process.platform === "win32" ? "windows-creation" : "posix-lstart";
}

function comparisonToIncarnation(comparison: ProcessIdentityComparison): ProcessIncarnation {
  return comparison === "different" ? "gone" : comparison;
}

async function observeLinuxIncarnation(
  pid: number,
  expected: LinuxProcessIdentity,
  timeoutMs: number,
): Promise<ProcessIncarnation> {
  const observed = await readLinuxObservation(pid, timeoutMs).catch(() => undefined);
  if (!observed) {
    return "unknown";
  }
  const scope = compareLinuxScope(expected, observed.scope);
  if (scope !== "matching") {
    return comparisonToIncarnation(scope);
  }
  // A PID missing in this namespace says nothing about an owner in another one.
  // Only accept numeric-PID death after validating the stored observer scope.
  if (isProcessDefinitelyDead(pid)) {
    return "gone";
  }
  return observed.identity
    ? comparisonToIncarnation(compareProcessBirthIdentity(expected, observed.identity))
    : "unknown";
}

export async function observeProcessIncarnation(
  pid: number,
  expected?: ProcessBirthIdentity,
  timeoutMs = IDENTITY_QUERY_TIMEOUT_MS,
): Promise<ProcessIncarnation> {
  if (!isPositivePid(pid)) {
    return "unknown";
  }
  if (expected?.kind === "linux-proc") {
    return process.platform === "linux"
      ? await observeLinuxIncarnation(pid, expected, timeoutMs)
      : "unknown";
  }
  if (expected && expected.kind !== nativeIdentityKind()) {
    return "unknown";
  }
  return await observeTimestampIncarnation(pid, expected, timeoutMs);
}

async function observeTimestampIncarnation(
  pid: number,
  expected: TimestampIdentity | undefined,
  timeoutMs: number,
): Promise<ProcessIncarnation> {
  if (isProcessDefinitelyDead(pid)) {
    return "gone";
  }
  if (!expected) {
    return "unknown";
  }
  const observed = await probeProcessIdentity(pid, timeoutMs);
  if (observed.state === "dead") {
    return "gone";
  }
  return observed.state === "alive"
    ? comparisonToIncarnation(compareProcessBirthIdentity(expected, observed.identity))
    : "unknown";
}

export async function getOwnProcessIdentity(): Promise<ProcessBirthIdentity | undefined> {
  if (ownIdentity) {
    return ownIdentity;
  }
  // Concurrent lease/guard publication can share self discovery. Foreign-PID
  // probes remain fresh because their result may authorize destructive recovery.
  ownIdentityPending ??= probeProcessIdentity(process.pid)
    .then((probe) => {
      if (probe.state === "alive") {
        ownIdentity = probe.identity;
      }
      return ownIdentity;
    })
    .finally(() => {
      ownIdentityPending = undefined;
    });
  return await ownIdentityPending;
}
