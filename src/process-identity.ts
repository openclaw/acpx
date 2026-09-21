import path from "node:path";
import { runTimedExecFile } from "./acp/client-process.js";
import { isProcessDefinitelyDead } from "./process-liveness.js";

export type ProcessBirthIdentity = {
  kind: "posix-lstart" | "windows-creation";
  value: string;
};

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
  if (identity.kind !== "posix-lstart" && identity.kind !== "windows-creation") {
    return undefined;
  }
  if (!isCanonicalBirth(identity.value, identity.kind)) {
    return undefined;
  }
  return { kind: identity.kind, value: identity.value };
}

function isCanonicalBirth(value: unknown, kind: ProcessBirthIdentity["kind"]): value is string {
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
  return parseProcessBirthIdentity({ kind: "posix-lstart", value: valueUtc })?.value;
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
  return process.platform === "win32"
    ? parseProcessBirthIdentity({ kind: "windows-creation", value })?.value
    : posixBirth(value);
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
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { state: "unknown" };
  }
  if (isProcessDefinitelyDead(pid)) {
    return { state: "dead" };
  }
  try {
    const entry = (await readProcessTable(timeoutMs, pid)).get(pid);
    if (entry) {
      return {
        state: "alive",
        identity: processBirthIdentity(entry.birth),
      };
    }
  } catch {
    // Query failure and missing rows are not proof that a PID is safe to reclaim.
  }
  return { state: isProcessDefinitelyDead(pid) ? "dead" : "unknown" };
}

function processBirthIdentity(value: string): ProcessBirthIdentity {
  return { kind: process.platform === "win32" ? "windows-creation" : "posix-lstart", value };
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
