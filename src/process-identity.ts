import fs from "node:fs";
import path from "node:path";
import { PROCESS_HELPER_MAX_BUFFER_BYTES, runTimedExecFile } from "./acp/client-process.js";
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
  birth: ProcessBirthIdentity;
  clockTicksPerSecond?: bigint;
};

export type LinuxExitClock = { centiseconds: bigint; timeNamespace: string };

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
  const prefix = async (name, size) => {
    const file = await fs.open(name, 'r');
    try {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString('base64');
    } finally { await file.close(); }
  };
  const targets = async () => {
    if (targetPid !== 'all') {
      return { targetStat: await fs.readFile('/proc/' + targetPid + '/stat', 'utf8').catch(() => null) };
    }
    const required = new Set(JSON.parse(process.argv[3] || '[]'));
    const pids = new Set((await fs.readdir('/proc')).filter(pid => /^[1-9][0-9]*$/.test(pid)));
    for (const pid of required) pids.add(String(pid));
    const processStats = [];
    let bytes = 0;
    // Sequential reads keep proc I/O and retained memory bounded within this
    // single killable helper; never launch one helper or pending read per PID.
    for (const pid of [...pids].sort((a, b) => Number(a) - Number(b))) {
      let stat;
      try { stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
        if (!required.has(Number(pid)) && (error.code === 'EACCES' || error.code === 'EPERM')) continue;
        throw error;
      }
      bytes += Buffer.byteLength(JSON.stringify(stat)) + 1;
      if (bytes > ${PROCESS_HELPER_MAX_BUFFER_BYTES} - 8192) throw new Error('Process table exceeds its byte limit');
      processStats.push(stat);
    }
    return { processStats, auxv: await prefix('/proc/self/auxv', 4096), elf: await prefix('/proc/self/exe', 6) };
  };
  Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readlink('/proc/self/ns/pid'),
    timeNamespace('self'),
    fs.readlink('/proc/' + observerPid + '/ns/pid'),
    timeNamespace(observerPid),
    fs.readFile('/proc/self/stat', 'utf8'),
    targets(),
  ]).then(([bootId, pidNamespace, timeNamespace, observerPidNamespace,
    observerTimeNamespace, selfStat, target]) => {
    process.stdout.write(JSON.stringify({bootId: bootId.trim(), pidNamespace,
      timeNamespace, observerPidNamespace, observerTimeNamespace,
      helperPid: process.pid, selfStat, ...target}));
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

function parseLinuxStat(
  raw: unknown,
): { pid: number; parentPid: number; groupPid: number; startTicks: string } | undefined {
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
  if (!isPositivePid(pid) || !isStartTicks(startTicks) || !/^[RSDTtKWPI]$/.test(fields[0])) {
    return undefined;
  }
  const parentPid = Number(fields[1]);
  const groupPid = Number(fields[2]);
  return validProcessLinks(parentPid, groupPid)
    ? { pid, parentPid, groupPid, startTicks }
    : undefined;
}

function validProcessLinks(parentPid: number, groupPid: number): boolean {
  return (
    Number.isSafeInteger(parentPid) &&
    parentPid >= 0 &&
    Number.isSafeInteger(groupPid) &&
    groupPid >= 0
  );
}

async function readLinuxQuery(
  pid: number | "all",
  timeoutMs: number,
  requiredPids: readonly number[] = [],
): Promise<Record<string, unknown>> {
  const args = [
    "--input-type=commonjs",
    "-e",
    LINUX_PROCESS_QUERY,
    String(pid),
    String(process.pid),
  ];
  if (pid === "all") {
    args.push(JSON.stringify(requiredPids));
  }
  const output = await runTimedExecFile(process.execPath, args, {
    timeoutMs,
    maxBufferBytes: pid === "all" ? PROCESS_HELPER_MAX_BUFFER_BYTES : 8_192,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return JSON.parse(output) as Record<string, unknown>;
}

function verifiedLinuxScope(raw: Record<string, unknown>): LinuxProcessScope | undefined {
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
  return scope;
}

async function readLinuxObservation(
  pid: number,
  timeoutMs: number,
): Promise<{ scope: LinuxProcessScope; identity?: LinuxProcessIdentity } | undefined> {
  const raw = await readLinuxQuery(pid, timeoutMs);
  const scope = verifiedLinuxScope(raw);
  if (!scope) {
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

function linuxAuxv(raw: Record<string, unknown>): {
  auxv: Buffer;
  size: number;
  littleEndian: boolean;
} {
  if (typeof raw.elf !== "string" || typeof raw.auxv !== "string") {
    throw new Error("Linux process clock is unavailable");
  }
  const elf = Buffer.from(raw.elf, "base64");
  const auxv = Buffer.from(raw.auxv, "base64");
  if (
    elf.subarray(0, 4).toString("hex") !== "7f454c46" ||
    ![1, 2].includes(elf[4]) ||
    ![1, 2].includes(elf[5])
  ) {
    throw new Error("Linux process clock has an invalid ELF format");
  }
  const size = elf[4] === 1 ? 4 : 8;
  return { auxv, size, littleEndian: elf[5] === 1 };
}

function linuxClockTicks(raw: Record<string, unknown>): bigint {
  const { auxv, size, littleEndian } = linuxAuxv(raw);
  const word = (offset: number) => readAuxvWord(auxv, offset, size, littleEndian);
  // AT_CLKTCK is supplied by the ELF loader in native unsigned-long words.
  // Keep both ABI widths and byte orders; do not assume USER_HZ is 100.
  for (let offset = 0; offset + size * 2 <= auxv.length; offset += size * 2) {
    const key = word(offset);
    if (key === 0n) {
      break;
    }
    if (key === 17n && word(offset + size) > 0n) {
      return word(offset + size);
    }
  }
  throw new Error("Linux process clock has no AT_CLKTCK");
}

function readAuxvWord(buffer: Buffer, offset: number, size: number, littleEndian: boolean): bigint {
  if (size === 8) {
    return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  }
  return BigInt(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
}

async function readLinuxProcessTable(
  timeoutMs: number,
  requiredPids: readonly number[],
  pid?: number,
): Promise<Map<number, ProcessTableEntry>> {
  const raw = await readLinuxQuery("all", timeoutMs, requiredPids);
  const scope = verifiedLinuxScope(raw);
  if (!scope || !Array.isArray(raw.processStats)) {
    throw new Error("Linux process table scope is unverified");
  }
  const clockTicksPerSecond = linuxClockTicks(raw);
  const table = new Map<number, ProcessTableEntry>();
  for (const value of raw.processStats as unknown[]) {
    const stat = parseLinuxStat(value);
    if (stat && (pid === undefined || stat.pid === pid)) {
      table.set(stat.pid, {
        pid: stat.pid,
        parentPid: stat.parentPid,
        groupPid: stat.groupPid,
        birth: { kind: "linux-proc", ...scope, startTicks: stat.startTicks },
        clockTicksPerSecond,
      });
    }
  }
  return table;
}

export function readLinuxExitClock(): LinuxExitClock | undefined {
  // The exit observer needs the cutoff now, before another process can reuse
  // the group. This capped native proc read has no fallback or I/O deadline.
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync("/proc/uptime", "r");
    const buffer = Buffer.alloc(64);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const match = /^(\d+)\.(\d{2})\s/u.exec(buffer.toString("ascii", 0, bytes));
    return match
      ? {
          centiseconds: BigInt(match[1]) * 100n + BigInt(match[2]),
          timeNamespace: readOwnTimeNamespace(),
        }
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Never retry close: an interrupted Linux close may already release its fd.
      }
    }
  }
}

function readOwnTimeNamespace(): string {
  try {
    return fs.readlinkSync("/proc/self/ns/time");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "unsupported";
    }
    throw error;
  }
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
      table.set(pid, {
        pid,
        parentPid: Number(match[2]),
        groupPid: Number(match[3]),
        birth: processBirthIdentity(birth),
      });
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
  requiredPids: readonly number[] = [],
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
  if (process.platform === "linux") {
    return await readLinuxProcessTable(timeoutMs, requiredPids, pid);
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
  return entry?.birth;
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
