import { execFile, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandParts = {
  command: string;
  args: string[];
};

type ResolveSessionCwdOptions = {
  platform?: NodeJS.Platform;
  existsSync?: (filePath: string) => boolean;
  runWslpath?: (cwd: string) => Promise<string>;
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

export async function resolveAgentSessionCwd(
  cwd: string,
  agentCommand: string,
  options: ResolveSessionCwdOptions = {},
): Promise<string> {
  const resolved = asAbsoluteCwd(cwd);
  if (!shouldTranslateWslWindowsCwd(agentCommand, options)) {
    return resolved;
  }

  const translated = (await (options.runWslpath ?? runWslpath)(resolved)).trim();
  if (!translated) {
    throw new Error(`wslpath returned an empty Windows path for cwd: ${resolved}`);
  }
  return translated;
}

function shouldTranslateWslWindowsCwd(
  agentCommand: string,
  options: ResolveSessionCwdOptions,
): boolean {
  if (!isWsl(options)) {
    return false;
  }

  try {
    const { command } = splitCommandLine(agentCommand);
    return isWindowsExecutableCommand(command);
  } catch {
    return false;
  }
}

function isWsl(options: ResolveSessionCwdOptions): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return false;
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
}

function isWindowsExecutableCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith(".exe") || normalized.startsWith("/mnt/c/");
}

async function runWslpath(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("wslpath", ["-w", cwd], {
    encoding: "utf8",
  });
  return stdout;
}

export function basenameToken(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, "");
}
