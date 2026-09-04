import { spawn, type ChildProcess } from "node:child_process";
import { TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";
import { hasShellProcesses, stopShellProcess } from "./shell-process.js";

function writeShellStdin(child: ChildProcess, stdin: string | undefined): void {
  const stream = child.stdin;
  if (!stream) {
    return;
  }
  stream.on("error", () => {
    // A child may close its input early; its exit status remains authoritative.
  });
  if (stdin != null && stream.writable && !stream.writableEnded) {
    stream.write(stdin);
  }
  if (stream.writable && !stream.writableEnded) {
    stream.end();
  }
}

export function formatShellActionSummary(spec: ShellActionExecution): string {
  return `shell: ${renderShellCommand(spec.command, spec.args ?? [])}`;
}

export function renderShellCommand(command: string, args: string[]): string {
  const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function createShellFailureError(
  spec: ShellActionExecution,
  args: string[],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const status = signal ? `signal ${signal}` : `exit ${String(exitCode)}`;
  const details = stderr.length > 0 ? `\n${stderr.trim()}` : "";
  return new Error(
    `Shell action failed (${renderShellCommand(spec.command, args)}): ${status}${details}`,
  );
}

/**
 * Resolve a shell-action timeout.
 * Non-positive values match withTimeout: no deadline (undefined).
 * Positive values arm SIGTERM/SIGKILL after that many ms.
 */
export function resolveShellActionTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !(timeoutMs > 0)) {
    return undefined;
  }
  return timeoutMs;
}

export type ShellProcessOwner = {
  cancel: (signal: NodeJS.Signals) => Promise<void>;
  release: () => void;
};

export type RunShellActionOptions = {
  /** Cancellation waits for the owned process tree to terminate. */
  signal?: AbortSignal;
  terminationSignal?: NodeJS.Signals;
  registerOwner?: (owner: ShellProcessOwner) => () => void;
};

export async function withShellAbort<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function rejectIfShellFailed(
  spec: ShellActionExecution,
  args: string[],
  result: ShellActionResult,
  timedOut: boolean,
  timeoutMs: number | undefined,
): Error | undefined {
  if (timedOut) {
    return new TimeoutError(timeoutMs ?? spec.timeoutMs ?? 0);
  }
  if (((result.exitCode ?? 0) !== 0 || result.signal != null) && spec.allowNonZeroExit !== true) {
    return createShellFailureError(spec, args, result.exitCode, result.signal, result.stderr);
  }
  return undefined;
}

function waitForShellExit(
  child: ChildProcess,
  spec: ShellActionExecution,
  args: string[],
  cwd: string,
  startMs: number,
  timeoutMs: number | undefined,
  timedOut: () => boolean,
): Promise<ShellActionResult> {
  let stdout = "";
  let stderr = "";

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) {
    throw new Error("Shell action child is missing stdio pipes");
  }

  return new Promise<ShellActionResult>((resolve, reject) => {
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      const result: ShellActionResult = {
        command: spec.command,
        args,
        cwd,
        stdout,
        stderr,
        combinedOutput: `${stdout}${stderr}`,
        exitCode,
        signal,
        durationMs: Date.now() - startMs,
      };

      const error = rejectIfShellFailed(spec, args, result, timedOut(), timeoutMs);
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

function createShellTermination(
  child: ChildProcess,
  timeoutMs: number | undefined,
  options: RunShellActionOptions,
) {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let rejectCleanup: (error: unknown) => void = () => {};
  const cleanupFailure = new Promise<never>((_resolve, reject) => {
    rejectCleanup = reject;
  });
  let termination: Promise<void> | undefined;
  let timedOut = false;
  let released = false;
  let deadline: NodeJS.Timeout | undefined;
  let monitor: NodeJS.Timeout | undefined;
  let unregister: (() => void) | undefined;
  const clearDeadline = () => {
    if (deadline) {
      clearTimeout(deadline);
    }
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearDeadline();
    if (monitor) {
      clearInterval(monitor);
    }
    options.signal?.removeEventListener("abort", onAbort);
    unregister?.();
  };
  const cancel = (signal: NodeJS.Signals): Promise<void> => {
    if (termination) {
      return termination;
    }
    if (released) {
      return Promise.resolve();
    }
    timedOut = true;
    termination = stopShellProcess(child, closed, signal).finally(release);
    void termination.catch(rejectCleanup);
    return termination;
  };
  const onAbort = () => {
    void cancel(options.terminationSignal ?? "SIGTERM");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs != null) {
    deadline = setTimeout(() => {
      void cancel("SIGTERM");
    }, timeoutMs);
  }
  unregister = options.registerOwner?.({ cancel, release });
  if (unregister) {
    child.once("close", () => {
      if (released || termination) {
        return;
      }
      const prune = () => {
        if (!termination && !hasShellProcesses(child)) {
          release();
        }
      };
      monitor = setInterval(prune, 100);
      monitor.unref();
      prune();
    });
  }
  return {
    timedOut: () => timedOut,
    cleanupFailure,
    async dispose() {
      clearDeadline();
      try {
        await termination;
      } finally {
        if (!unregister) {
          release();
        }
      }
    },
  };
}

export async function runShellAction(
  spec: ShellActionExecution,
  options: RunShellActionOptions = {},
): Promise<ShellActionResult> {
  if (options?.signal?.aborted) {
    throw options.signal.reason;
  }
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
  const timeoutMs = resolveShellActionTimeoutMs(spec.timeoutMs);
  const child = spawn(spec.command, args, {
    cwd,
    env: {
      ...process.env,
      ...spec.env,
    },
    shell: spec.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const termination = createShellTermination(child, timeoutMs, options);
  const finish = waitForShellExit(child, spec, args, cwd, startMs, timeoutMs, termination.timedOut);
  writeShellStdin(child, spec.stdin);
  try {
    return await Promise.race([finish, termination.cleanupFailure]);
  } finally {
    await termination.dispose();
  }
}
