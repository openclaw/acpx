import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  isChildProcessRunning,
  PROCESS_HELPER_TIMEOUT_MS,
  runTimedExecFile,
} from "./client-process.js";

type ProcessIdentity = { pid: number; parentPid: number; birth: string };

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
      if (owned.has(identity.parentPid) && !owned.has(identity.pid)) {
        owned.add(identity.pid);
        expanded = true;
      }
    }
  } while (expanded);
}

/** Best-effort POSIX cleanup for descendants witnessed during this child launch. */
export class ProcessDescendants {
  private identities = new Map<number, ProcessIdentity>();
  private pending: Promise<boolean> | undefined;
  private retired = false;

  constructor(private readonly child: ChildProcess) {}

  capture(timeoutMs = PROCESS_HELPER_TIMEOUT_MS): Promise<boolean> {
    if (this.retired || process.platform === "win32") {
      return Promise.resolve(true);
    }
    this.pending ??= this.readSnapshot(timeoutMs).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async readSnapshot(timeoutMs: number): Promise<boolean> {
    try {
      const output = await runTimedExecFile("ps", ["-eo", "pid=,ppid=,stat=,lstart="], {
        timeoutMs,
      });
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
    const root = this.child.pid;
    if (root && isChildProcessRunning(this.child)) {
      owned.add(root);
    }
    includeDescendants(table, owned);
    owned.delete(root ?? 0);
    this.identities = new Map([...table].filter(([pid]) => owned.has(pid)));
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
