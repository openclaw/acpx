import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { defaultRunsDir, listRunBundles, resolveRunBundleFilePath } from "./server/run-bundles.js";

const HOST = "127.0.0.1";
const PORT = 4173;
const SERVER_ID = "acpx-flow-replay-viewer";

async function main(): Promise<void> {
  const baseUrl = `http://${HOST}:${PORT}`;

  if (await isServerAlreadyRunning(baseUrl)) {
    process.stdout.write(`Viewer already running at ${baseUrl}/\n`);
    return;
  }

  const viewerDir = path.dirname(fileURLToPath(import.meta.url));
  const vite = await createViteServer({
    configFile: path.join(viewerDir, "vite.config.ts"),
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: false,
      host: HOST,
      port: PORT,
      strictPort: true,
    },
  });

  const server = http.createServer(async (request, response) => {
    if (await handleApiRequest(request, response)) {
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

  server.on("error", async (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && (await isServerAlreadyRunning(baseUrl))) {
      process.stdout.write(`Viewer already running at ${baseUrl}/\n`);
      process.exit(0);
      return;
    }
    throw error;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stdout.write(`Viewer running at ${baseUrl}/\n`);

  const close = async (): Promise<void> => {
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
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

async function handleApiRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/api/health") {
    writeJson(response, 200, {
      service: SERVER_ID,
      runsDir: defaultRunsDir(),
    });
    return true;
  }

  if (url.pathname === "/api/runs") {
    const runs = await listRunBundles();
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
      const filePath = resolveRunBundleFilePath(defaultRunsDir(), runId, relativePath ?? "");
      const payload = await fs.readFile(filePath);
      response.statusCode = 200;
      response.setHeader("content-type", contentTypeFor(filePath));
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

async function isServerAlreadyRunning(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { service?: string };
    return payload.service === SERVER_ID;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
