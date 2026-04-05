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

      if (timedOut) {
        reject(new TimeoutError(spec.timeoutMs ?? 0));
        return;
      }

      if (((exitCode ?? 0) !== 0 || signal != null) && spec.allowNonZeroExit !== true) {
        reject(
          new Error(
            `Shell action failed (${renderShellCommand(spec.command, args)}): ${signal ? `signal ${signal}` : `exit ${String(exitCode)}`}${stderr.length > 0 ? `\n${stderr.trim()}` : ""}`,
          ),
        );
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
