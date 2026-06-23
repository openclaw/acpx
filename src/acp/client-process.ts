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
  let hasPart = false;

  for (const ch of value) {
    const next = readCommandLineChar({ ch, current, quote, escaping, parts, hasPart });
    current = next.current;
    quote = next.quote;
    escaping = next.escaping;
    hasPart = next.hasPart;
  }

  if (escaping) {
    current += "\\";
    hasPart = true;
  }

  if (quote) {
    throw new Error("Invalid --agent command: unterminated quote");
  }

  if (hasPart) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Invalid --agent command: empty command");
  }
  if (parts[0] === "") {
    throw new Error("Invalid --agent command: empty command");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function readCommandLineChar(state: {
  ch: string;
  current: string;
  quote: "'" | '"' | null;
  escaping: boolean;
  parts: string[];
  hasPart: boolean;
}): { current: string; quote: "'" | '"' | null; escaping: boolean; hasPart: boolean } {
  if (state.escaping) {
    return {
      current: state.current + state.ch,
      quote: state.quote,
      escaping: false,
      hasPart: true,
    };
  }
  if (state.ch === "\\" && state.quote !== "'") {
    return {
      current: state.current,
      quote: state.quote,
      escaping: true,
      hasPart: state.hasPart,
    };
  }
  if (state.quote) {
    return readQuotedCommandLineChar({
      ch: state.ch,
      current: state.current,
      quote: state.quote,
      hasPart: state.hasPart,
    });
  }
  return readUnquotedCommandLineChar(state);
}

function readQuotedCommandLineChar(state: {
  ch: string;
  current: string;
  quote: "'" | '"';
  hasPart: boolean;
}): {
  current: string;
  quote: "'" | '"' | null;
  escaping: boolean;
  hasPart: boolean;
} {
  if (state.ch === state.quote) {
    return { current: state.current, quote: null, escaping: false, hasPart: true };
  }
  return {
    current: state.current + state.ch,
    quote: state.quote,
    escaping: false,
    hasPart: true,
  };
}

function readUnquotedCommandLineChar(state: {
  ch: string;
  current: string;
  parts: string[];
  hasPart: boolean;
}): {
  current: string;
  quote: "'" | '"' | null;
  escaping: boolean;
  hasPart: boolean;
} {
  if (state.ch === "'" || state.ch === '"') {
    return { current: state.current, quote: state.ch, escaping: false, hasPart: true };
  }
  if (/\s/.test(state.ch)) {
    flushCommandLinePart(state.parts, state.current, state.hasPart);
    return { current: "", quote: null, escaping: false, hasPart: false };
  }
  return {
    current: state.current + state.ch,
    quote: null,
    escaping: false,
    hasPart: true,
  };
}

function flushCommandLinePart(parts: string[], current: string, hasPart: boolean): void {
  if (hasPart) {
    parts.push(current);
  }
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

const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(?:exe|cmd|bat)$/u;

function isWindowsExecutableCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return WINDOWS_EXECUTABLE_EXTENSION_RE.test(normalized);
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
