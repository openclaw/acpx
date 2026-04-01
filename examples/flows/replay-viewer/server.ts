import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRunsDir } from "./server/run-bundles.js";
import {
  createReplayViewerServer,
  fetchViewerServerHealth,
  requestViewerServerShutdown,
} from "./server/viewer-server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;

export type ReplayViewerCliCommand = "start" | "status" | "stop";

export type ReplayViewerCliOptions = {
  command: ReplayViewerCliCommand;
  host: string;
  port: number;
  runsDir: string;
  open: boolean;
};

export function parseReplayViewerCliArgs(argv: readonly string[]): ReplayViewerCliOptions {
  let command: ReplayViewerCliCommand = "start";
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let runsDir = defaultRunsDir();
  let open = false;

  const args = [...argv];
  const first = args[0];
  if (first === "start" || first === "status" || first === "stop") {
    command = first;
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) {
      continue;
    }
    if (current === "--open") {
      open = true;
      continue;
    }
    if (current === "--host") {
      host = requireArgValue(args, ++index, "--host");
      continue;
    }
    if (current.startsWith("--host=")) {
      host = current.slice("--host=".length);
      continue;
    }
    if (current === "--port") {
      port = parsePort(requireArgValue(args, ++index, "--port"));
      continue;
    }
    if (current.startsWith("--port=")) {
      port = parsePort(current.slice("--port=".length));
      continue;
    }
    if (current === "--runs-dir") {
      runsDir = requireArgValue(args, ++index, "--runs-dir");
      continue;
    }
    if (current.startsWith("--runs-dir=")) {
      runsDir = current.slice("--runs-dir=".length);
      continue;
    }
    throw new Error(`Unknown replay viewer argument: ${current}`);
  }

  return {
    command,
    host,
    port,
    runsDir,
    open,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseReplayViewerCliArgs(argv);
  const baseUrl = `http://${options.host}:${options.port}`;
  const requestedRunsDir = normalizeRunsDirPath(options.runsDir);

  switch (options.command) {
    case "status": {
      const health = await fetchViewerServerHealth(baseUrl);
      if (!health) {
        process.stdout.write(`Viewer is not running at ${baseUrl}/\n`);
        return;
      }
      process.stdout.write(`Viewer is running at ${baseUrl}/\n`);
      process.stdout.write(`Runs dir: ${health.runsDir}\n`);
      return;
    }
    case "stop": {
      const stopped = await requestViewerServerShutdown(baseUrl);
      process.stdout.write(
        stopped ? `Stopped viewer at ${baseUrl}/\n` : `Viewer is not running at ${baseUrl}/\n`,
      );
      return;
    }
    case "start": {
      const health = await fetchViewerServerHealth(baseUrl);
      if (health) {
        const runningRunsDir = normalizeRunsDirPath(health.runsDir);
        if (runningRunsDir !== requestedRunsDir) {
          throw new Error(
            `Viewer is already running at ${baseUrl}/ for ${health.runsDir}, not ${options.runsDir}`,
          );
        }
        process.stdout.write(`Reused existing viewer at ${baseUrl}/\n`);
        process.stdout.write(`Runs dir: ${health.runsDir}\n`);
        if (options.open) {
          await openViewerUrl(baseUrl);
        }
        return;
      }

      const viewerServer = await createReplayViewerServer({
        host: options.host,
        port: options.port,
        runsDir: options.runsDir,
      });

      process.stdout.write(`Started viewer at ${viewerServer.baseUrl}/\n`);
      process.stdout.write(`Runs dir: ${options.runsDir}\n`);

      if (options.open) {
        await openViewerUrl(viewerServer.baseUrl);
      }

      const close = async (): Promise<void> => {
        await viewerServer.close();
      };

      process.on("SIGINT", () => {
        void close().finally(() => process.exit(0));
      });
      process.on("SIGTERM", () => {
        void close().finally(() => process.exit(0));
      });
      return;
    }
  }
}

async function openViewerUrl(url: string): Promise<void> {
  const { command, args } = resolveOpenCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`viewer open command exited with code ${code ?? "null"}`));
    });
  });
}

function resolveOpenCommand(url: string): {
  command: string;
  args: string[];
} {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

function normalizeRunsDirPath(runsDir: string): string {
  try {
    return realpathSync(runsDir);
  } catch {
    return path.resolve(runsDir);
  }
}

function requireArgValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(rawPort: string): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid replay viewer port: ${rawPort}`);
  }
  return port;
}

function isReplayViewerEntrypoint(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isReplayViewerEntrypoint(process.argv)) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
