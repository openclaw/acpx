import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { readBundleFile } from "./filesystem-bundle-reader.js";
import { createFilesystemRunSource } from "./live-source.js";
import { createReplayLiveSyncServer } from "./live-sync.js";
import { defaultRunsDir, listRunBundles } from "./run-bundles.js";

const SERVER_ID = "acpx-flow-replay-viewer";

export type ReplayViewerServerOptions = {
  host?: string;
  port?: number;
  runsDir?: string;
  livePollIntervalMs?: number;
  disableDependencyOptimization?: boolean;
};

export type ReplayViewerServer = {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
};

export type ReplayViewerServerHealth = {
  service: string;
  runsDir: string;
};

export async function createReplayViewerServer(
  options: ReplayViewerServerOptions = {},
): Promise<ReplayViewerServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const runsDir = options.runsDir ?? defaultRunsDir();
  const viewerDir = path.dirname(fileURLToPath(import.meta.url));
  const configFile = resolveViewerConfigFile(viewerDir);
  const vite = await createViteServer({
    configFile,
    appType: "spa",
    ...(options.disableDependencyOptimization
      ? {
          optimizeDeps: {
            noDiscovery: true,
          },
        }
      : {}),
    server: {
      middlewareMode: true,
      hmr: false,
      host,
      port,
      strictPort: false,
    },
  });
  const liveSyncServer = createReplayLiveSyncServer({
    source: createFilesystemRunSource(runsDir),
    pollIntervalMs: options.livePollIntervalMs,
  });
  let closePromise: Promise<void> | null = null;

  const requestClose = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeServer(server, vite, liveSyncServer);
    }
    return closePromise;
  };

  const server = http.createServer(async (request, response) => {
    if (
      await handleApiRequest(request, response, host, port, runsDir, {
        requestClose,
      })
    ) {
      return;
    }

    vite.middlewares(request, response, (error: unknown) => {
      if (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end("Not found");
    });
  });

  server.on("upgrade", (request, socket, head) => {
    void liveSyncServer.handleUpgrade(request, socket, head).then((handled) => {
      if (handled) {
        return;
      }
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Replay viewer server failed to bind a TCP address.");
  }
  const actualPort = address.port;

  return {
    host,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    async close(): Promise<void> {
      await requestClose();
    },
  };
}

function resolveViewerConfigFile(viewerServerDir: string): string {
  const compiledPath = path.join(viewerServerDir, "..", "vite.config.ts");
  if (fs.existsSync(compiledPath)) {
    return compiledPath;
  }
  return path.resolve(process.cwd(), "examples/flows/replay-viewer/vite.config.ts");
}

export async function handleApiRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  host: string,
  port: number,
  runsDir: string,
  options: {
    requestClose?: () => Promise<void>;
  } = {},
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (url.pathname === "/api/health") {
    writeJson(response, 200, {
      service: SERVER_ID,
      runsDir,
    });
    return true;
  }

  if (url.pathname === "/api/control/shutdown" && request.method === "POST") {
    writeJson(response, 200, {
      ok: true,
    });
    setImmediate(() => {
      void options.requestClose?.();
    });
    return true;
  }

  if (url.pathname === "/api/runs") {
    const runs = await listRunBundles(runsDir);
    writeJson(response, 200, {
      runs,
    });
    return true;
  }

  const runFileMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/files\/(.+)$/);
  if (runFileMatch) {
    const [, encodedRunId, encodedRelativePath] = runFileMatch;
    const runId = decodeURIComponent(encodedRunId ?? "");
    const relativePath = encodedRelativePath
      ?.split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");

    try {
      const payload = await readBundleFile(runsDir, runId, relativePath ?? "");
      response.statusCode = 200;
      response.setHeader("content-type", contentTypeFor(relativePath ?? ""));
      response.end(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && /outside run bundle|not allowed|required/.test(error.message)
          ? 400
          : 404;
      writeJson(response, code, { error: message });
    }
    return true;
  }

  return false;
}

export async function isServerAlreadyRunning(baseUrl: string): Promise<boolean> {
  return (await fetchViewerServerHealth(baseUrl)) != null;
}

export async function fetchViewerServerHealth(
  baseUrl: string,
): Promise<ReplayViewerServerHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as Partial<ReplayViewerServerHealth>;
    return payload.service === SERVER_ID && typeof payload.runsDir === "string"
      ? {
          service: payload.service,
          runsDir: payload.runsDir,
        }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestViewerServerShutdown(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`${baseUrl}/api/control/shutdown`, {
      method: "POST",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function closeServer(
  server: http.Server,
  vite: ViteDevServer,
  liveSyncServer: ReturnType<typeof createReplayLiveSyncServer>,
): Promise<void> {
  await liveSyncServer.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  }).finally(async () => {
    await vite.close();
  });
}

function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".ndjson")) {
    return "application/x-ndjson; charset=utf-8";
  }
  if (filePath.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}
