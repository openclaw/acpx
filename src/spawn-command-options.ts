import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
  return matchedKey ? env[matchedKey] : undefined;
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const extensions = (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const commandExtension = path.extname(command);
  const candidates =
    commandExtension.length > 0
      ? [command]
      : extensions.map((extension) => `${command}${extension}`);
  const hasPath = command.includes("/") || command.includes("\\") || path.isAbsolute(command);

  if (hasPath) {
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  const pathValue = readWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(";")) {
    const trimmedDirectory = directory.trim();
    if (trimmedDirectory.length === 0) {
      continue;
    }
    for (const candidate of candidates) {
      const resolved = path.join(trimmedDirectory, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }

  return undefined;
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

export type ShellExec = {
  command: string;
  args: string[];
};

/**
 * Resolve a `terminal/create` request into an actual `spawn()` argv pair.
 *
 * The ACP `CreateTerminalRequest` schema models `command` as the executable
 * and `args` as its argument vector, mirroring `child_process.spawn(cmd, args)`.
 * In practice, several agents (Claude Code, Codex-style wrappers, and others)
 * place a full shell command line in the `command` field and leave `args`
 * empty. Other ACP clients — notably Zed via its `ShellBuilder` — handle this
 * by always running the request through the system shell, so those agents work
 * out of the box. Spawning the unsplit string directly fails with `ENOENT`
 * because the shell line is treated as an executable name.
 *
 * To match the de facto behavior of other ACP clients, when `args` is empty we
 * route the command through `/bin/sh -c <command>` on Unix or `cmd.exe /C
 * <command>` on Windows. When `args` is non-empty we honor the literal ACP
 * contract and spawn `command` with the provided argv unchanged. This keeps
 * well-behaved agents on the original direct-spawn fast path while letting
 * "raw shell line" agents work transparently.
 */
export function buildShellExec(
  command: string,
  args: string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellExec {
  if (args && args.length > 0) {
    return { command, args };
  }
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: "/bin/sh", args: ["-c", command] };
}
