import { spawn, type ChildProcess } from "node:child_process";
import { TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";

export const DEFAULT_SHELL_ACTION_MAX_BUFFER_BYTES = 1024 * 1024;

function createMaxBufferError(stream: "stdout" | "stderr", maxBufferBytes: number): Error {
  return new Error(
    `Shell action exceeded maxBuffer (${String(maxBufferBytes)} bytes) on ${stream}`,
  );
}

export function resolveShellActionMaxBufferBytes(maxBufferBytes: number | undefined): number {
  if (maxBufferBytes == null) {
    return DEFAULT_SHELL_ACTION_MAX_BUFFER_BYTES;
  }
  if (
    typeof maxBufferBytes !== "number" ||
    !Number.isFinite(maxBufferBytes) ||
    !Number.isInteger(maxBufferBytes) ||
    maxBufferBytes < 0
  ) {
    throw new Error(
      `Shell action maxBufferBytes must be a finite non-negative integer (got ${String(maxBufferBytes)})`,
    );
  }
  return maxBufferBytes;
}

function appendCappedShellOutput(
  current: string,
  chunk: string,
  maxBufferBytes: number,
): { value: string; overflowed: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBufferBytes) {
    return { value: current, overflowed: true };
  }
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (currentBytes + chunkBytes <= maxBufferBytes) {
    return { value: `${current}${chunk}`, overflowed: false };
  }
  const remaining = maxBufferBytes - currentBytes;
  const sliced = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
  return { value: `${current}${sliced}`, overflowed: true };
}

function stopReadingShellOutput(child: ChildProcess): void {
  child.stdout?.pause();
  child.stderr?.pause();
}

function signalShellTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") {
      args.push("/f");
    }
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  try {
    // Child is spawned detached so it is the process-group leader; -pid reaps
    // shell wrappers plus pipeline/background descendants in that group.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited between overflow detection and signal delivery.
    }
  }
}

function killShellChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid) {
    signalShellTree(pid, "SIGTERM");
    setTimeout(() => {
      signalShellTree(pid, "SIGKILL");
    }, 1_000).unref();
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
  }, 1_000).unref();
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
  overflowedStream: "stdout" | "stderr" | undefined,
  maxBufferBytes: number,
): Error | undefined {
  if (overflowedStream) {
    return createMaxBufferError(overflowedStream, maxBufferBytes);
  }
  if (timedOut) {
    return new TimeoutError(spec.timeoutMs ?? 0);
  }
  if (((result.exitCode ?? 0) !== 0 || result.signal != null) && spec.allowNonZeroExit !== true) {
    return createShellFailureError(spec, args, result.exitCode, result.signal, result.stderr);
  }
  return undefined;
}

export async function runShellAction(spec: ShellActionExecution): Promise<ShellActionResult> {
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const maxBufferBytes = resolveShellActionMaxBufferBytes(spec.maxBufferBytes);
  const startMs = Date.now();
  // Detached on POSIX so the child leads a new process group and overflow/timeout
  // cleanup can signal -pid (shell pipelines and background jobs included).
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

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let overflowedStream: "stdout" | "stderr" | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const finish = new Promise<ShellActionResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const takeChunk = (stream: "stdout" | "stderr", chunk: string): void => {
      if (overflowedStream) {
        return;
      }
      const next = appendCappedShellOutput(
        stream === "stdout" ? stdout : stderr,
        chunk,
        maxBufferBytes,
      );
      if (stream === "stdout") {
        stdout = next.value;
      } else {
        stderr = next.value;
      }
      if (next.overflowed) {
        overflowedStream = stream;
        stopReadingShellOutput(child);
        killShellChild(child);
      }
    };
    child.stdout.on("data", (chunk: string) => {
      takeChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      takeChunk("stderr", chunk);
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

      const error = rejectIfShellFailed(
        spec,
        args,
        result,
        timedOut,
        overflowedStream,
        maxBufferBytes,
      );
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });

  if (spec.stdin != null) {
    child.stdin.write(spec.stdin);
  }
  child.stdin.end();

  if (spec.timeoutMs != null && spec.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      killShellChild(child);
    }, spec.timeoutMs);
  }

  try {
    return await finish;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
