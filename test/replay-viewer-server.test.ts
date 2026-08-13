import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_VIEWER_HELP_TEXT,
  main as replayViewerMain,
  parseReplayViewerCliArgs,
} from "../examples/flows/replay-viewer/server.js";
import {
  createReplayViewerServer,
  fetchViewerServerHealth,
  isServerAlreadyRunning,
  requestViewerServerShutdown,
} from "../examples/flows/replay-viewer/server/viewer-server.js";

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
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };

  try {
    await replayViewerMain(["--help"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = lines.join("");
  assert.equal(output, REPLAY_VIEWER_HELP_TEXT);
  assert.match(output, /--runs-dir <path>/);
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
  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    disableDependencyOptimization: true,
  });

  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  };

  try {
    await replayViewerMain(["status", "--port", String(viewerServer.port)]);
  } finally {
    process.stdout.write = originalWrite;
    await viewerServer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }

  assert.match(lines.join(""), /Viewer is running at http:\/\/127\.0\.0\.1:/);
  assert.match(lines.join(""), new RegExp(`Runs dir: ${escapeRegExp(runsDir)}`));
});

test("replay viewer start rejects reusing a server for a different runs dir", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-start-runs-a-"));
  const otherRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-start-runs-b-"));
  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    disableDependencyOptimization: true,
  });

  try {
    await assert.rejects(
      replayViewerMain(["start", "--port", String(viewerServer.port), "--runs-dir", otherRunsDir]),
      /Viewer is already running .* not .*acpx-replay-start-runs-b-/,
    );
  } finally {
    await viewerServer.close().catch(() => {});
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(otherRunsDir, { recursive: true, force: true });
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
