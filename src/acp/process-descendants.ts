import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isChildProcessRunning,
  PROCESS_HELPER_TIMEOUT_MS,
  runTimedExecFile,
} from "./client-process.js";

type ProcessIdentity = { pid: number; parentPid: number; birth: string };

const WINDOWS_PROCESS_SNAPSHOT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {",
  "if ($null -ne $_.CreationDate) {",
  "'{0} {1} S {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o')",
  "}",
  "}",
].join("\n");

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows system directory is unavailable");
  }
  // A bare executable name searches the project directory before PATH on Windows.
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseProcessTable(output: string): Map<number, ProcessIdentity> {
  const table = new Map<number, ProcessIdentity>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match && !match[3].startsWith("Z")) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        table.set(pid, { pid, parentPid: Number(match[2]), birth: match[4] });
      }
    }
  }
  return table;
}

function includeDescendants(table: Map<number, ProcessIdentity>, owned: Set<number>): void {
  let expanded: boolean;
  do {
    expanded = false;
    for (const identity of table.values()) {
      const parent = table.get(identity.parentPid);
      // Windows keeps the creator PID after it exits. A later process with that
      // PID cannot own an older child; UTC roundtrip timestamps sort by birth.
      if (process.platform === "win32" && (!parent || parent.birth > identity.birth)) {
        continue;
      }
      if (owned.has(identity.parentPid) && !owned.has(identity.pid)) {
        owned.add(identity.pid);
        expanded = true;
      }
    }
  } while (expanded);
}

/** Best-effort cleanup for descendants witnessed during this child launch. */
export class ProcessDescendants {
  private identities = new Map<number, ProcessIdentity>();
  private rootBirth: string | undefined;
  private pending: Promise<boolean> | undefined;
  private retired = false;

  constructor(private readonly child: ChildProcess) {}

  capture(timeoutMs = PROCESS_HELPER_TIMEOUT_MS): Promise<boolean> {
    if (this.retired) {
      return Promise.resolve(true);
    }
    this.pending ??= this.readSnapshot(timeoutMs).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async readSnapshot(timeoutMs: number): Promise<boolean> {
    try {
      const output =
        process.platform === "win32"
          ? await runTimedExecFile(
              windowsPowerShellPath(),
              ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SNAPSHOT],
              { timeoutMs, windowsHide: true },
            )
          : await runTimedExecFile("ps", ["-eo", "pid=,ppid=,stat=,lstart="], { timeoutMs });
      if (!this.retired) {
        this.refresh(parseProcessTable(output));
      }
      return true;
    } catch {
      return false;
    }
  }

  private refresh(table: Map<number, ProcessIdentity>): void {
    const owned = new Set<number>();
    for (const [pid, identity] of this.identities) {
      if (table.get(pid)?.birth === identity.birth) {
        owned.add(pid);
      }
    }
    this.includeRoot(table, owned);
    includeDescendants(table, owned);
    owned.delete(this.child.pid ?? 0);
    this.identities = new Map([...table].filter(([pid]) => owned.has(pid)));
  }

  private includeRoot(table: Map<number, ProcessIdentity>, owned: Set<number>): void {
    const root = this.child.pid;
    const rootIdentity = root && table.get(root);
    if (rootIdentity && isChildProcessRunning(this.child)) {
      this.rootBirth ??= rootIdentity.birth;
      if (rootIdentity.birth === this.rootBirth) {
        owned.add(rootIdentity.pid);
      }
    }
  }

  async signal(signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
    if (!(await this.capture(timeoutMs)) || this.retired) {
      return;
    }
    // Never signal a saved PID without a fresh matching birth identity.
    for (const pid of this.identities.keys()) {
      try {
        process.kill(pid, signal);
      } catch {
        this.identities.delete(pid);
      }
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!(await this.capture(Math.max(1, deadline - Date.now())))) {
        return false;
      }
      if (this.identities.size === 0) {
        return true;
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return false;
  }

  retire(): void {
    this.retired = true;
    this.identities.clear();
  }
}
