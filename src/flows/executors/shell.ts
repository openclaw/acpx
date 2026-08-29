import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { InterruptedError, TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";

const SHELL_CHILD_KILL_GRACE_MS = 1_000;

function terminateShellChild(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
  }, SHELL_CHILD_KILL_GRACE_MS).unref();
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

function rejectIfShellFailed(
  spec: ShellActionExecution,
  args: string[],
  result: ShellActionResult,
  timedOut: boolean,
): Error | undefined {
  if (timedOut) {
    return new TimeoutError(spec.timeoutMs ?? 0);
  }
  if (((result.exitCode ?? 0) !== 0 || result.signal != null) && spec.allowNonZeroExit !== true) {
    return createShellFailureError(spec, args, result.exitCode, result.signal, result.stderr);
  }
  return undefined;
}

function settleShellResult(
  spec: ShellActionExecution,
  args: string[],
  result: ShellActionResult,
  timedOut: boolean,
  aborted: boolean,
): Error | undefined {
  if (aborted && !timedOut) {
    return new InterruptedError();
  }
  return rejectIfShellFailed(spec, args, result, timedOut);
}

function scheduleShellTimeout(
  timeoutMs: number | undefined,
  onTimeout: () => void,
): NodeJS.Timeout | undefined {
  if (timeoutMs == null || timeoutMs <= 0) {
    return undefined;
  }
  return setTimeout(onTimeout, timeoutMs);
}

function spawnShellChild(
  spec: ShellActionExecution,
  cwd: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  return spawn(spec.command, args, {
    cwd,
    env: {
      ...process.env,
      ...spec.env,
    },
    shell: spec.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function writeShellStdin(child: ChildProcessWithoutNullStreams, stdin: string | undefined): void {
  if (stdin != null) {
    child.stdin.write(stdin);
  }
  child.stdin.end();
}

function bindShellAbort(
  signal: AbortSignal | undefined,
  child: ChildProcess,
): { isAborted: () => boolean; dispose: () => void } {
  let aborted = false;
  const onAbort = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    terminateShellChild(child);
  };
  if (!signal) {
    return {
      isAborted: () => aborted,
      dispose: () => undefined,
    };
  }
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return {
    isAborted: () => aborted,
    dispose: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function waitForShellExit(
  child: ChildProcessWithoutNullStreams,
  spec: ShellActionExecution,
  args: string[],
  cwd: string,
  startMs: number,
  getFlags: () => { timedOut: boolean; aborted: boolean },
): Promise<ShellActionResult> {
  let stdout = "";
  let stderr = "";
  return new Promise<ShellActionResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => {
      const flags = getFlags();
      const result: ShellActionResult = {
        command: spec.command,
        args,
        cwd,
        stdout,
        stderr,
        combinedOutput: `${stdout}${stderr}`,
        exitCode,
        signal: exitSignal,
        durationMs: Date.now() - startMs,
      };
      const error = settleShellResult(spec, args, result, flags.timedOut, flags.aborted);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

async function runSpawnedShellAction(
  spec: ShellActionExecution,
  signal: AbortSignal | undefined,
): Promise<ShellActionResult> {
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
  const child = spawnShellChild(spec, cwd, args);
  let timedOut = false;
  const abort = bindShellAbort(signal, child);
  const finish = waitForShellExit(child, spec, args, cwd, startMs, () => ({
    timedOut,
    aborted: abort.isAborted(),
  }));
  writeShellStdin(child, spec.stdin);
  const timeout = scheduleShellTimeout(spec.timeoutMs, () => {
    timedOut = true;
    terminateShellChild(child);
  });

  try {
    return await finish;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abort.dispose();
  }
}

export async function runShellAction(
  spec: ShellActionExecution,
  options?: { signal?: AbortSignal },
): Promise<ShellActionResult> {
  if (options?.signal?.aborted) {
    throw new InterruptedError();
  }
  return await runSpawnedShellAction(spec, options?.signal);
}
