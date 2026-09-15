import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  REPLAY_VIEWER_HELP_TEXT,
  parseReplayViewerCliArgs,
} from "../examples/flows/replay-viewer/server.js";
import {
  createReplayViewerServer,
  fetchViewerServerHealth,
  isServerAlreadyRunning,
  requestViewerServerShutdown,
} from "../examples/flows/replay-viewer/server/viewer-server.js";

const execFileAsync = promisify(execFile);
const viewerCliPath = fileURLToPath(
  new URL("../examples/flows/replay-viewer/server.js", import.meta.url),
);

async function startHealthFixture(runsDir: string): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ service: "acpx-flow-replay-viewer", runsDir }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("parseReplayViewerCliArgs defaults to start and supports control flags", () => {
  assert.deepEqual(parseReplayViewerCliArgs([]), {
    command: "start",
    host: "127.0.0.1",
    port: 4173,
    runsDir: path.join(os.homedir(), ".acpx", "flows", "runs"),
    open: false,
  });

  assert.deepEqual(
    parseReplayViewerCliArgs([
      "status",
      "--host",
      "0.0.0.0",
      "--port=4317",
      "--runs-dir",
      "/tmp/acpx-runs",
      "--open",
    ]),
    {
      command: "status",
      host: "0.0.0.0",
      port: 4317,
      runsDir: "/tmp/acpx-runs",
      open: true,
    },
  );
});

test("parseReplayViewerCliArgs rejects invalid flags", () => {
  assert.throws(() => parseReplayViewerCliArgs(["--port", "0"]), /Invalid replay viewer port/);
  assert.throws(() => parseReplayViewerCliArgs(["--runs-dir"]), /--runs-dir requires a value/);
  assert.throws(() => parseReplayViewerCliArgs(["--wat"]), /Unknown replay viewer argument: --wat/);
});

test("replay viewer CLI prints help without starting a server", async () => {
  const { stdout } = await execFileAsync(process.execPath, [viewerCliPath, "--help"]);
  assert.equal(stdout, REPLAY_VIEWER_HELP_TEXT);
  assert.match(stdout, /--runs-dir <path>/);
});

test("replay viewer status and stop helpers report and stop a running server", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-status-"));
  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    disableDependencyOptimization: true,
  });

  try {
    const health = await fetchViewerServerHealth(viewerServer.baseUrl);
    assert.deepEqual(health, {
      service: "acpx-flow-replay-viewer",
      runsDir,
    });
    assert.equal(await isServerAlreadyRunning(viewerServer.baseUrl), true);
    assert.equal(await requestViewerServerShutdown(viewerServer.baseUrl), true);
    await waitFor(async () => !(await isServerAlreadyRunning(viewerServer.baseUrl)));
  } finally {
    await viewerServer.close().catch(() => {});
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("replay viewer CLI status prints running details", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-status-cli-"));
  const viewerServer = await startHealthFixture(runsDir);

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      viewerCliPath,
      "status",
      "--port",
      String(viewerServer.port),
    ]);
    assert.match(stdout, /Viewer is running at http:\/\/127\.0\.0\.1:/);
    assert.match(stdout, new RegExp(`Runs dir: ${escapeRegExp(runsDir)}`));
  } finally {
    await viewerServer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("replay viewer start rejects reusing a server for a different runs dir", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-start-runs-a-"));
  const otherRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-start-runs-b-"));
  const viewerServer = await startHealthFixture(runsDir);

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        viewerCliPath,
        "start",
        "--port",
        String(viewerServer.port),
        "--runs-dir",
        otherRunsDir,
      ]),
      /Viewer is already running .* not .*acpx-replay-start-runs-b-/,
    );
  } finally {
    await viewerServer.close().catch(() => {});
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(otherRunsDir, { recursive: true, force: true });
  }
});

test("replay viewer releases startup resources when its HTTP port is occupied", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-startup-"));
  const occupied = http.createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const { createReplayViewerServer } = await import(process.argv[1]);
            try {
              await createReplayViewerServer({
                host: "127.0.0.1",
                port: Number(process.argv[2]),
                runsDir: process.argv[3],
                disableDependencyOptimization: true,
              });
            } catch (error) {
              process.stderr.write(error.code + "\\n");
              process.exitCode = 1;
            }
          `,
          new URL("../examples/flows/replay-viewer/server/viewer-server.js", import.meta.url).href,
          String(address.port),
          runsDir,
        ],
        { timeout: 10_000, killSignal: "SIGKILL" },
      ),
      { code: 1, killed: false, signal: null, stderr: "EADDRINUSE\n" },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("replay viewer blocks file reads that escape the runs directory via runId", async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-traversal-"));
  const runsDir = path.join(fakeHome, ".acpx", "flows", "runs");
  const sessionsDir = path.join(fakeHome, ".acpx", "sessions");
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, "session-secret.json"), '{"token":"SESSION_SECRET"}');

  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    disableDependencyOptimization: true,
  });

  try {
    const response = await fetch(
      `${viewerServer.baseUrl}/api/runs/..%2F..%2Fsessions/files/session-secret.json`,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Run bundle file not found" });
  } finally {
    await viewerServer.close().catch(() => {});
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test("replay viewer does not reveal whether a denied symlink target exists", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-symlink-oracle-"));
  const runsDir = path.join(rootDir, "runs");
  const outsideDir = path.join(rootDir, "outside");
  const runDir = path.join(runsDir, "hostile");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "exists.txt"), "secret");
  await fs.symlink(path.join(outsideDir, "exists.txt"), path.join(runDir, "existing-link"));
  await fs.symlink(path.join(outsideDir, "missing.txt"), path.join(runDir, "missing-link"));

  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    disableDependencyOptimization: true,
  });

  try {
    const responses = await Promise.all(
      ["existing-link", "missing-link", "ordinary-missing"].map(async (name) => {
        const response = await fetch(`${viewerServer.baseUrl}/api/runs/hostile/files/${name}`);
        return {
          status: response.status,
          body: await response.json(),
        };
      }),
    );

    assert.deepEqual(responses, [
      { status: 404, body: { error: "Run bundle file not found" } },
      { status: 404, body: { error: "Run bundle file not found" } },
      { status: 404, body: { error: "Run bundle file not found" } },
    ]);
  } finally {
    await viewerServer.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for replay viewer condition.");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
