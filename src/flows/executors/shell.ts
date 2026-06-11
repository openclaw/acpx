import { spawn } from "node:child_process";
import { TimeoutError } from "../../async-control.js";
import type { ShellActionExecution, ShellActionResult } from "../runtime.js";

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

export async function runShellAction(spec: ShellActionExecution): Promise<ShellActionResult> {
  const cwd = spec.cwd ?? process.cwd();
  const args = spec.args ?? [];
  const startMs = Date.now();
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

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  const finish = new Promise<ShellActionResult>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
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

      const error = rejectIfShellFailed(spec, args, result, timedOut);
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
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000).unref();
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
