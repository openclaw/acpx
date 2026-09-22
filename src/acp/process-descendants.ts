import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  compareProcessBirthIdentity,
  readLinuxExitClock,
  readProcessTable,
  type LinuxExitClock,
  type ProcessBirthIdentity,
  type ProcessTableEntry,
} from "../process-identity.js";
import { isChildProcessRunning, PROCESS_HELPER_TIMEOUT_MS } from "./client-process.js";

function hasStaleWindowsParent(
  identity: ProcessTableEntry,
  parent: ProcessTableEntry | undefined,
): boolean {
  // Windows keeps the creator PID after it exits. A later process with that
  // PID cannot own an older child; UTC roundtrip timestamps sort by birth.
  return (
    identity.birth.kind === "windows-creation" &&
    (parent?.birth.kind !== "windows-creation" || parent.birth.value > identity.birth.value)
  );
}

function includeDescendants(table: Map<number, ProcessTableEntry>, owned: Set<number>): void {
  let expanded: boolean;
  do {
    expanded = false;
    for (const identity of table.values()) {
      const parent = table.get(identity.parentPid);
      if (hasStaleWindowsParent(identity, parent)) {
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
  private identities = new Map<number, ProcessTableEntry>();
  private rootBirth: ProcessBirthIdentity | undefined;
  private pending: Promise<boolean> | undefined;
  private retired = false;
  private readonly ownProcessGroup: boolean;
  private captureGroupAfterExit: boolean;
  private groupExitedAt: number | LinuxExitClock | null | undefined;
  private readonly onRootExit = () => {
    this.groupExitedAt = process.platform === "linux" ? (readLinuxExitClock() ?? null) : Date.now();
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
      const table = await readProcessTable(
        timeoutMs,
        undefined,
        this.requiredSnapshotPids(rootWasRunning),
      );
      if (!this.retired) {
        // Identity probes include self and PID 1; descendant custody never does.
        table.delete(1);
        table.delete(process.pid);
        this.refresh(table, captureRootGroup);
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

  private requiredSnapshotPids(rootWasRunning: boolean): number[] {
    // An exited root PID may already belong to an inaccessible foreign process.
    // Only the live root and witnessed descendants still require observation.
    return [
      ...this.identities.keys(),
      ...(rootWasRunning && this.child.pid ? [this.child.pid] : []),
    ];
  }

  private refresh(table: Map<number, ProcessTableEntry>, rootWasRunning: boolean): void {
    this.verifyScope(table);
    const owned = new Set<number>();
    for (const [pid, identity] of this.identities) {
      const observed = table.get(pid);
      if (observed && compareProcessBirthIdentity(identity.birth, observed.birth) === "matching") {
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

  private verifyScope(table: Map<number, ProcessTableEntry>): void {
    const expected = this.rootBirth ?? this.identities.values().next().value?.birth;
    const observation = table.values().next().value?.birth;
    if (
      expected &&
      observation &&
      compareProcessBirthIdentity(expected, observation) === "unknown"
    ) {
      throw new Error("Descendant process scope changed");
    }
  }

  private includeRoot(table: Map<number, ProcessTableEntry>, owned: Set<number>): void {
    const root = this.child.pid;
    const rootIdentity = root && table.get(root);
    if (rootIdentity && isChildProcessRunning(this.child)) {
      this.rootBirth ??= rootIdentity.birth;
      if (compareProcessBirthIdentity(this.rootBirth, rootIdentity.birth) === "matching") {
        owned.add(rootIdentity.pid);
      }
    }
  }

  private includeProcessGroup(
    table: Map<number, ProcessTableEntry>,
    owned: Set<number>,
    rootWasRunning: boolean,
  ): void {
    const root = this.child.pid;
    // A shell can exit while its first snapshot is in flight. Its recorded exit
    // bounds the final snapshot; subsequent discovery requires a witnessed member.
    if (root && (rootWasRunning || [...owned].some((pid) => table.get(pid)?.groupPid === root))) {
      for (const identity of table.values()) {
        if (identity.groupPid === root && this.startedBeforeRootExit(identity)) {
          owned.add(identity.pid);
        }
      }
    }
  }

  private startedBeforeRootExit(identity: ProcessTableEntry): boolean {
    const cutoff = this.groupExitedAt;
    if (cutoff === undefined) {
      return true;
    }
    if (cutoff === null) {
      return false;
    }
    if (identity.birth.kind !== "linux-proc") {
      return typeof cutoff === "number" && Date.parse(identity.birth.value) <= cutoff;
    }
    if (
      typeof cutoff === "number" ||
      identity.birth.timeNamespace !== cutoff.timeNamespace ||
      !identity.clockTicksPerSecond
    ) {
      return false;
    }
    // /proc/uptime floors to centiseconds and stat floors to USER_HZ ticks.
    // Compare the recorded exit's 10ms interval, without wall-clock conversion.
    return (
      BigInt(identity.birth.startTicks) * 100n <
      (cutoff.centiseconds + 1n) * identity.clockTicksPerSecond
    );
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
    const deadline = performance.now() + timeoutMs;
    do {
      if (!(await this.capture(Math.max(1, deadline - performance.now())))) {
        return false;
      }
      if (this.identities.size === 0) {
        return true;
      }
      await delay(Math.min(100, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
    return false;
  }

  retire(): void {
    this.retired = true;
    this.child.off("exit", this.onRootExit);
    this.identities.clear();
  }
}
