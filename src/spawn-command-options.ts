import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
  return matchedKey ? env[matchedKey] : undefined;
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  return (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const commandExtension = path.extname(command);
  if (commandExtension.length > 0) {
    return [command];
  }
  return windowsExecutableExtensions(env).map((extension) => `${command}${extension}`);
}

function commandHasPath(command: string): boolean {
  return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function resolveWindowsPathCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = commandCandidates(command, env);
  const pathValue = readWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(";")) {
    const resolved = findExistingCommandInDirectory(directory, candidates);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function findExistingCommandInDirectory(
  directory: string,
  candidates: string[],
): string | undefined {
  const trimmedDirectory = directory.trim();
  if (trimmedDirectory.length === 0) {
    return undefined;
  }

  return candidates
    .map((candidate) => path.join(trimmedDirectory, candidate))
    .find((resolved) => fs.existsSync(resolved));
}

function resolveWindowsWrapperToken(token: string, wrapperPath: string): string | undefined {
  const relative = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i)?.[1]?.trim();
  if (!relative) {
    return undefined;
  }
  const candidate = path.resolve(
    path.dirname(wrapperPath),
    relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, ""),
  );
  return path.extname(candidate).toLowerCase() === ".exe" && fs.existsSync(candidate)
    ? candidate
    : undefined;
}

function resolveWindowsWrapperExecutable(wrapperPath: string): string | undefined {
  if (!fs.existsSync(wrapperPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(wrapperPath, "utf8");
    return [...content.matchAll(/"([^"\r\n]*)"/g)]
      .map((match) => resolveWindowsWrapperToken(match[1] ?? "", wrapperPath))
      .find((candidate): candidate is string => candidate !== undefined);
  } catch {
    // Ignore unreadable wrapper scripts and let callers use their fallback.
    return undefined;
  }
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = commandCandidates(command, env);

  if (commandHasPath(command)) {
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  return resolveWindowsPathCommand(command, env);
}

/**
 * Resolve a Windows command to a native executable suitable for direct spawn.
 *
 * Batch and PowerShell shims are intentionally rejected unless they point at a
 * real `.exe` entrypoint. Callers that need shell execution should use the
 * command-specific shell policy instead.
 */
export function resolveWindowsExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) {
    return undefined;
  }

  const absolute = path.resolve(resolved);
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".exe") {
    return absolute;
  }
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    return undefined;
  }

  const siblingExecutable = `${absolute.slice(0, -extension.length)}.exe`;
  return fs.existsSync(siblingExecutable)
    ? siblingExecutable
    : resolveWindowsWrapperExecutable(absolute);
}

function shouldUseWindowsBatchShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const resolvedCommand = resolveWindowsCommand(command, env) ?? command;
  const ext = path.extname(resolvedCommand).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

export function buildSpawnCommandOptions(
  command: string,
  options: Parameters<typeof spawn>[2],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Parameters<typeof spawn>[2] {
  if (!shouldUseWindowsBatchShell(command, platform, env)) {
    return options;
  }
  return {
    ...options,
    shell: true,
  };
}

export type TerminalSpawnCommand = {
  command: string;
  args: string[];
  killProcessGroup: boolean;
};

export function buildTerminalSpawnCommand(
  command: string,
  args: string[] | undefined,
): TerminalSpawnCommand {
  return { command, args: args ?? [], killProcessGroup: false };
}

export function buildTerminalShellSpawnCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnCommand {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command], killProcessGroup: true };
  }
  return { command: "/bin/sh", args: ["-c", command], killProcessGroup: true };
}
