import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isChildProcessRunning,
  PROCESS_HELPER_TIMEOUT_MS,
  runTimedExecFile,
} from "./client-process.js";

type ProcessIdentity = { pid: number; parentPid: number; groupPid: number; birth: string };

const WINDOWS_PROCESS_SNAPSHOT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {",
  "if ($null -ne $_.CreationDate) {",
  "'{0} {1} 0 S {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o')",
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
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match && !match[4].startsWith("Z")) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        table.set(pid, {
          pid,
          parentPid: Number(match[2]),
          groupPid: Number(match[3]),
          birth: match[5],
        });
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
  private readonly ownProcessGroup: boolean;
  private captureGroupAfterExit: boolean;
  private groupExitedAt: number | undefined;
  private readonly onRootExit = () => {
    this.groupExitedAt = Date.now();
  };

  constructor(
    private readonly child: ChildProcess,
    options: { ownProcessGroup?: boolean } = {},
  ) {
    this.ownProcessGroup = process.platform !== "win32" && Boolean(options.ownProcessGroup);
    this.captureGroupAfterExit = this.ownProcessGroup && isChildProcessRunning(child);
    if (this.ownProcessGroup) {
      child.once("exit", this.onRootExit);
    }
  }

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
    const deadline = performance.now() + timeoutMs;
    const rootWasRunning = isChildProcessRunning(this.child);
    const captureRootGroup = rootWasRunning || this.captureGroupAfterExit;
    if (!rootWasRunning) {
      this.captureGroupAfterExit = false;
    }
    try {
      // Keep POSIX lstart parseable when bounding the final group snapshot by root exit.
      const output =
        process.platform === "win32"
          ? await runTimedExecFile(
              windowsPowerShellPath(),
              ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SNAPSHOT],
              { timeoutMs, windowsHide: true },
            )
          : await runTimedExecFile("ps", ["-eo", "pid=,ppid=,pgid=,stat=,lstart="], {
              timeoutMs,
              env: { ...process.env, LC_ALL: "C" },
            });
      if (!this.retired) {
        this.refresh(parseProcessTable(output), captureRootGroup);
        // An in-flight snapshot can precede the shell's last fork. Join one fresh
        // exit snapshot before retiring its group ownership or resolving terminal exit.
        if (this.captureGroupAfterExit && !isChildProcessRunning(this.child)) {
          return await this.readSnapshot(Math.max(1, deadline - performance.now()));
        }
      }
      return true;
    } catch {
      if (!isChildProcessRunning(this.child)) {
        this.captureGroupAfterExit = false;
      }
      return false;
    }
  }

  private refresh(table: Map<number, ProcessIdentity>, rootWasRunning: boolean): void {
    const owned = new Set<number>();
    for (const [pid, identity] of this.identities) {
      if (table.get(pid)?.birth === identity.birth) {
        owned.add(pid);
      }
    }
    this.includeRoot(table, owned);
    if (this.ownProcessGroup) {
      this.includeProcessGroup(table, owned, rootWasRunning);
    }
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

  private includeProcessGroup(
    table: Map<number, ProcessIdentity>,
    owned: Set<number>,
    rootWasRunning: boolean,
  ): void {
    const root = this.child.pid;
    // A shell can exit while its first snapshot is in flight. Its recorded exit
    // bounds the final snapshot; subsequent discovery requires a witnessed member.
    if (root && (rootWasRunning || [...owned].some((pid) => table.get(pid)?.groupPid === root))) {
      for (const identity of table.values()) {
        if (
          identity.groupPid === root &&
          (this.groupExitedAt === undefined || Date.parse(identity.birth) <= this.groupExitedAt)
        ) {
          owned.add(identity.pid);
        }
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

  hasTrackedProcesses(): boolean {
    return this.identities.size > 0;
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
    this.child.off("exit", this.onRootExit);
    this.identities.clear();
  }
}
