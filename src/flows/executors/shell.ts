import { spawn, type ChildProcess } from "node:child_process";
import { InterruptedError, TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";
import type { FlowShellExecution, FlowShellResult } from "../types.js";
import { createShellOutputCapture, validateShellActionMaxBufferBytes } from "./shell-output.js";
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

function waitForShellResult(
  child: ChildProcess,
  spec: ShellActionExecution,
  args: string[],
  cwd: string,
  startMs: number,
  termination: {
    timedOut: () => boolean;
    cancelled: () => boolean;
    cancel: ShellProcessOwner["cancel"];
  },
  mode: "node" | "command",
): Promise<FlowShellResult> {
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) {
    throw new Error("Shell action child is missing stdio pipes");
  }

  return new Promise<FlowShellResult>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      settled = true;
      reject(error);
    };
    const capture = createShellOutputCapture(
      spec.maxBufferBytes,
      () => settled || (mode === "node" && termination.cancelled()),
      (error) => {
        if (termination.cancelled()) {
          return;
        }
        fail(error);
        void termination.cancel("SIGTERM").catch(fail);
      },
    );
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      capture.append("stdout", chunk);
    });
    stderrStream.on("data", (chunk: string) => {
      capture.append("stderr", chunk);
    });

    child.once("error", fail);
    child.once(mode === "node" ? "exit" : "close", (exitCode, signal) => {
      settled = true;
      if (mode === "node" && !termination.cancelled()) {
        // Keep inherited pipes draining without holding a completed host alive.
        (stdoutStream as typeof stdoutStream & { unref: () => void }).unref();
        (stderrStream as typeof stderrStream & { unref: () => void }).unref();
      }
      const { stdout, stderr } = capture.output;
      const result: FlowShellResult = {
        command: spec.command,
        args,
        cwd,
        stdout,
        stderr,
        combinedOutput: `${stdout}${stderr}`,
        exitCode,
        signal,
        durationMs: Date.now() - startMs,
        timedOut: mode === "node" ? termination.cancelled() : termination.timedOut(),
      };
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
  let cancelled = false;
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
    clearDeadline();
    cancelled = true;
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
      timedOut = true;
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
    cancel,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
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
  const { timedOut, ...result } = await runShellProcess(spec, options, "node");
  const failure = rejectIfShellFailed(
    spec,
    result.args,
    result,
    timedOut,
    resolveShellActionTimeoutMs(spec.timeoutMs),
  );
  if (failure) {
    throw failure;
  }
  return result;
}

export async function runShellCommand(
  spec: FlowShellExecution,
  options: RunShellActionOptions,
): Promise<FlowShellResult> {
  return await runShellProcess(spec, options, "command");
}

async function runShellProcess(
  spec: ShellActionExecution,
  options: RunShellActionOptions,
  mode: "node" | "command",
): Promise<FlowShellResult> {
  options.signal?.throwIfAborted();
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
  const timeoutMs = resolveShellActionTimeoutMs(spec.timeoutMs);
  validateShellActionMaxBufferBytes(spec.maxBufferBytes);
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
  const finish = waitForShellResult(child, spec, args, cwd, startMs, termination, mode);
  writeShellStdin(child, spec.stdin);
  try {
    const result = await Promise.race([finish, termination.cleanupFailure]);
    throwIfShellCancelled(options.signal, mode);
    return result;
  } finally {
    await termination.dispose();
  }
}

function throwIfShellCancelled(signal: AbortSignal | undefined, mode: "node" | "command"): void {
  if (!signal?.aborted) {
    return;
  }
  const reason: unknown = signal.reason;
  if (mode === "command" || reason instanceof TimeoutError || reason instanceof InterruptedError) {
    throw reason;
  }
}
