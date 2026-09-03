import { spawn, type ChildProcess } from "node:child_process";
import { TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";

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
 * Positive finite values arm SIGTERM/SIGKILL after that many ms.
 */
export function resolveShellActionTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return timeoutMs;
}

export type RunShellActionOptions = {
  /** When aborted, reap the child (SIGTERM then SIGKILL). Used for outer node deadlines. */
  signal?: AbortSignal;
};

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

type ShellTermination = {
  timedOut: () => boolean;
  terminate: () => void;
  armTimeout: (timeoutMs: number | undefined) => void;
  armAbort: (signal: AbortSignal | undefined) => void;
  dispose: () => void;
};

function createShellTermination(child: ChildProcess): ShellTermination {
  let timedOut = false;
  let terminated = false;
  let timeout: NodeJS.Timeout | undefined;
  let killFollowUp: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    timedOut = true;
    child.kill("SIGTERM");
    killFollowUp = setTimeout(() => {
      child.kill("SIGKILL");
    }, 1_000);
    killFollowUp.unref();
  };

  let abortSignal: AbortSignal | undefined;

  return {
    timedOut: () => timedOut,
    terminate,
    armTimeout(timeoutMs) {
      // Positive timeout only. Zero/negative/undefined = no shell-action deadline.
      if (timeoutMs == null) {
        return;
      }
      timeout = setTimeout(terminate, timeoutMs);
    },
    armAbort(signal) {
      abortSignal = signal;
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        terminate();
        return;
      }
      signal.addEventListener("abort", terminate, { once: true });
    },
    dispose() {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killFollowUp) {
        clearTimeout(killFollowUp);
      }
      abortSignal?.removeEventListener("abort", terminate);
    },
  };
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

export async function runShellAction(
  spec: ShellActionExecution,
  options?: RunShellActionOptions,
): Promise<ShellActionResult> {
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
  });

  const termination = createShellTermination(child);
  const finish = waitForShellExit(child, spec, args, cwd, startMs, timeoutMs, termination.timedOut);

  writeShellStdin(child, spec.stdin);
  termination.armTimeout(timeoutMs);
  termination.armAbort(options?.signal);

  try {
    return await finish;
  } finally {
    termination.dispose();
  }
}
