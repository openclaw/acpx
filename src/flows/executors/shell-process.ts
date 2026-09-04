import type { ChildProcess } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { runTimedExecFile } from "../../acp/client-process.js";
import { withTimeout } from "../../async-control.js";

const KILL_GRACE_MS = 1_000;
type PosixProcess = { pid: number; parent: number; group: number; state: string };

async function readPosixProcesses(): Promise<PosixProcess[]> {
  const output = await runTimedExecFile("ps", ["-eo", "pid=,ppid=,pgid=,stat="]);
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, group, state = ""] = line.trim().split(/\s+/u);
      return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
    })
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
}

function isLive(entry: PosixProcess): boolean {
  // Orphan zombies have terminated; only their new parent can reap them.
  return entry.state.length > 0 && !entry.state.startsWith("Z");
}

function rememberOwnedProcesses(rows: PosixProcess[], root: number, owned: Set<number>): void {
  for (const entry of rows) {
    if (entry.group === root) {
      owned.add(entry.pid);
    }
  }
  for (const parent of owned) {
    for (const entry of rows) {
      if (entry.parent === parent) {
        owned.add(entry.pid);
      }
    }
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function signalGroup(root: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-root, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return;
    }
    if (
      code === "EPERM" &&
      !(await readPosixProcesses()).some((entry) => entry.group === root && isLive(entry))
    ) {
      return;
    }
    throw error;
  }
}

async function signalOwned(
  root: number,
  owned: Set<number>,
  signal: NodeJS.Signals,
): Promise<void> {
  const rows = await readPosixProcesses();
  rememberOwnedProcesses(rows, root, owned);
  await signalGroup(root, signal);
  // Group members receive the initial signal once; escaped descendants need direct delivery.
  for (const entry of rows) {
    if (owned.has(entry.pid) && entry.group !== root && isLive(entry)) {
      signalPid(entry.pid, signal);
    }
  }
}

async function waitForOwned(root: number, owned: Set<number>): Promise<boolean> {
  const deadline = Date.now() + KILL_GRACE_MS;
  do {
    const rows = await readPosixProcesses();
    rememberOwnedProcesses(rows, root, owned);
    if (!rows.some((entry) => owned.has(entry.pid) && isLive(entry))) {
      return true;
    }
    await wait(25);
  } while (Date.now() < deadline);
  return false;
}

async function forceKnownProcesses(root: number, owned: Set<number>): Promise<void> {
  const results = await Promise.allSettled([
    signalGroup(root, "SIGKILL"),
    ...[...owned].map(async (pid) => signalPid(pid, "SIGKILL")),
  ]);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Known shell processes could not be stopped", {
      cause: errors[0],
    });
  }
}

async function stopPosixTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const owned = new Set([pid]);
  try {
    await signalOwned(pid, owned, signal);
    if (await waitForOwned(pid, owned)) {
      return;
    }
    await signalOwned(pid, owned, "SIGKILL");
    if (!(await waitForOwned(pid, owned))) {
      throw new Error("Shell process tree did not terminate after SIGKILL");
    }
  } catch (error) {
    try {
      await forceKnownProcesses(pid, owned);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Shell process cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

async function stopWindowsTree(child: ChildProcess): Promise<void> {
  if (child.pid == null || child.exitCode != null || child.signalCode != null) {
    return;
  }
  try {
    await runTimedExecFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
    });
  } catch (error) {
    // Do not infer Windows ancestry from reusable numeric ParentProcessId values.
    child.kill("SIGKILL");
    throw error;
  }
}

async function waitForShellClose(closed: Promise<void>): Promise<void> {
  try {
    await withTimeout(closed, KILL_GRACE_MS);
  } catch (cause) {
    throw new Error("Shell process streams did not close after termination", { cause });
  }
}

export async function stopShellProcess(
  child: ChildProcess,
  closed: Promise<void>,
  signal: NodeJS.Signals,
): Promise<void> {
  try {
    if (child.pid != null) {
      if (process.platform === "win32") {
        await stopWindowsTree(child);
      } else {
        await stopPosixTree(child.pid, signal);
      }
    }
  } catch (error) {
    try {
      await waitForShellClose(closed);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Shell process cleanup failed", {
        cause: closeError,
      });
    }
    throw error;
  }
  await waitForShellClose(closed);
}

export function hasShellProcesses(child: ChildProcess): boolean {
  if (child.pid == null) {
    return false;
  }
  if (process.platform === "win32") {
    return child.exitCode == null && child.signalCode == null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
