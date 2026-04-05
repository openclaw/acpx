import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";

export type CommandParts = {
  command: string;
  args: string[];
};

export function isoNow(): string {
  return new Date().toISOString();
}

export function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null;
}

export function requireAgentStdio(
  child: ChildProcess,
): ChildProcessByStdio<Writable, Readable, Readable> {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP agent must be spawned with piped stdin/stdout/stderr");
  }
  return child as ChildProcessByStdio<Writable, Readable, Readable>;
}

export function waitForChildExit(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildProcessRunning(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(0, timeoutMs),
    );

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("close", onExitLike);
      child.off("exit", onExitLike);
      clearTimeout(timer);
      resolve(value);
    };

    const onExitLike = () => {
      finish(true);
    };

    child.once("close", onExitLike);
    child.once("exit", onExitLike);
  });
}

export function splitCommandLine(value: string): CommandParts {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Invalid --agent command: unterminated quote");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Invalid --agent command: empty command");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function asAbsoluteCwd(cwd: string): string {
  return path.resolve(cwd);
}

export function basenameToken(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, "");
}
