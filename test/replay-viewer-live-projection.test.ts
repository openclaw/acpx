import assert from "node:assert/strict";
import { once } from "node:events";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FsSafeError } from "@openclaw/fs-safe";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { WebSocket } from "ws";
import { createFilesystemRunSource } from "../examples/flows/replay-viewer/server/live-source.js";
import { createReplayLiveSyncServer } from "../examples/flows/replay-viewer/server/live-sync.js";
import { isAllowedViewerRequest } from "../examples/flows/replay-viewer/server/request-origin.js";
import { readRunBundleFile } from "../examples/flows/replay-viewer/server/run-bundles.js";
import { applyReplayPatch } from "../examples/flows/replay-viewer/src/lib/json-patch-plus.js";
import type {
  ReplayServerMessage,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../examples/flows/replay-viewer/src/types.js";
import { compute, defineFlow } from "../src/flows/definition.js";
import { FlowRunStore } from "../src/flows/store.js";
import type { FlowRunState } from "../src/flows/types.js";

for (const resource of ["runs", "run"] as const) {
  test(`${resource} stream retains its last state during atomic live replacement`, async () => {
    const fixture = await createFixture();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    let gate: ReturnType<typeof createGate> | undefined;
    const sourceErrors: unknown[] = [];
    const observe = async <T>(read: Promise<T>): Promise<T> => {
      try {
        return await read;
      } catch (error) {
        sourceErrors.push(error);
        throw error;
      }
    };
    const source = createFilesystemRunSource(fixture.runsDir);
    const live = createReplayLiveSyncServer({
      source: {
        getRunsState: () => observe(source.getRunsState()),
        getRunState: (runId) => observe(source.getRunState(runId)),
      },
    });
    const server = http.createServer((_request, response) => response.writeHead(404).end());
    server.on("upgrade", (request, socket, head) => {
      if (
        !isAllowedViewerRequest(request, "127.0.0.1") ||
        !live.handleUpgrade(request, socket, head)
      ) {
        socket.destroy();
      }
    });
    let socket: WebSocket | undefined;
    try {
      const A = await fixture.heartbeat();
      const livePath = await fs.realpath(path.join(fixture.runDir, "projections/live.json"));
      __setFsSafeTestHooksForTest({
        async beforeRootReadFinalFence(filePath, handle) {
          if (filePath !== livePath || !gate || gate.entered) {
            return;
          }
          const held = gate;
          held.identity = await handle.stat({ bigint: true });
          held.entered = true;
          await held.promise;
        },
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/live`, { origin });
      const frames: ReplayServerMessage[] = [];
      const applied: Array<{ updatedAt: string | undefined; version: number }> = [];
      let state: ViewerRunsState | ViewerRunLiveState | undefined;
      let version = 0;
      let clientError: unknown;
      socket.on("message", (data) => {
        try {
          assert(Buffer.isBuffer(data));
          const message = JSON.parse(data.toString("utf8")) as ReplayServerMessage;
          frames.push(message);
          if (message.type === "runs_snapshot" || message.type === "run_snapshot") {
            assert(message.version >= version);
            state = message.state;
            version = message.version;
          } else if (message.type === "runs_patch" || message.type === "run_patch") {
            assert(state);
            assert.equal(message.fromVersion, version);
            assert.equal(message.toVersion, version + 1);
            state = applyReplayPatch(state, message.ops);
            version = message.toVersion;
          } else {
            return;
          }
          const run = "runsById" in state ? state.runsById[fixture.runId] : state.run;
          applied.push({ updatedAt: run?.updatedAt, version });
        } catch (error) {
          clientError = error;
        }
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
      socket.send(
        JSON.stringify(
          resource === "runs"
            ? { type: "subscribe_runs" }
            : { type: "subscribe_run", runId: fixture.runId },
        ),
      );
      await waitFor(() => applied.length > 0);
      assert.equal(clientError, undefined);
      assert.deepEqual(applied, [{ updatedAt: A, version: 1 }]);

      gate = createGate();
      await waitFor(() => Boolean(gate?.entered));
      const controlIdentity = await fs.stat(livePath, { bigint: true });
      assert.equal(gate.identity?.ino, controlIdentity.ino);
      gate.release();
      socket.send(
        JSON.stringify(
          resource === "runs"
            ? { type: "resync_runs" }
            : { type: "resync_run", runId: fixture.runId },
        ),
      );
      await waitFor(() => applied.length === 2);
      assert.deepEqual(applied[1], { updatedAt: A, version: 1 });
      assert.equal(sourceErrors.length, 0);

      gate = createGate();
      await waitFor(() => Boolean(gate?.entered));
      const B = await fixture.heartbeat();
      assert.notEqual(B, A);
      const replacement = await fs.stat(livePath, { bigint: true });
      assert.equal(gate.identity?.dev, replacement.dev);
      assert.notEqual(gate.identity?.ino, replacement.ino);
      assert.deepEqual(await fs.readFile(fixture.runPath), fixture.storedRun);
      gate.release();
      await waitFor(() => applied.some((entry) => entry.updatedAt === B));
      assert.equal(clientError, undefined);
      assert.deepEqual(applied, [
        { updatedAt: A, version: 1 },
        { updatedAt: A, version: 1 },
        { updatedAt: B, version: 2 },
      ]);
      assert.equal(sourceErrors.length, 1);
      assert(sourceErrors[0] instanceof FsSafeError);
      assert.equal(sourceErrors[0].code, "path-mismatch");
      const warning = frames.find((message) => message.type === "error");
      assert.equal(warning?.code, "internal_error");
      assert.equal(warning?.runId, resource === "run" ? fixture.runId : undefined);
      const recovered = frames.find(
        (message) =>
          (message.type === "runs_patch" && message.toVersion === 2) ||
          (message.type === "run_snapshot" && message.version === 2),
      );
      assert.equal(recovered?.type, resource === "runs" ? "runs_patch" : "run_snapshot");

      // A real removal must still retire the run, rather than preserving it as a read race.
      await fs.rm(fixture.runDir, { recursive: true, force: true });
      await waitFor(() =>
        resource === "runs"
          ? applied.some((entry) => entry.updatedAt === undefined)
          : frames.some((message) => message.type === "error" && message.code === "run_not_found"),
      );
      if (resource === "runs") {
        assert.deepEqual(applied.at(-1), { updatedAt: undefined, version: 3 });
      }
      socket.send(JSON.stringify({ type: "ping" }));
      await waitFor(() => frames.some((message) => message.type === "pong"));
      assert.equal(clientError, undefined);
      assert.equal(socket.readyState, WebSocket.OPEN);
    } finally {
      gate?.release();
      __setFsSafeTestHooksForTest(undefined);
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      }
      await live.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await fixture.close();
    }
  });
}

test("missing optional live projections still load the stored run", async () => {
  const fixture = await createFixture();
  try {
    await fixture.heartbeat();
    await fs.rm(path.join(fixture.runDir, "projections/live.json"));
    const source = createFilesystemRunSource(fixture.runsDir);
    assert.equal((await source.getRunsState()).runsById[fixture.runId]?.updatedAt, fixture.T0);
    const selected = await source.getRunState(fixture.runId);
    assert.equal(selected.run.updatedAt, fixture.T0);
    assert.equal(selected.live, null);
  } finally {
    await fixture.close();
  }
});

test(
  "optional live projections cannot read an outside symlink",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-live-outside-"));
    try {
      const livePath = path.join(fixture.runDir, "projections/live.json");
      const outsideFile = path.join(outside, "live.json");
      await fs.writeFile(outsideFile, JSON.stringify({ updatedAt: "outside sentinel" }));
      await fs.rm(livePath);
      await fs.symlink(outsideFile, livePath);
      await assert.rejects(
        readRunBundleFile(fixture.runsDir, fixture.runId, "projections/live.json"),
        FsSafeError,
      );
      const source = createFilesystemRunSource(fixture.runsDir);
      assert.equal((await source.getRunsState()).runsById[fixture.runId]?.updatedAt, fixture.T0);
      assert.equal((await source.getRunState(fixture.runId)).run.updatedAt, fixture.T0);
    } finally {
      await fixture.close();
      await fs.rm(outside, { recursive: true, force: true });
    }
  },
);

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, entered: false, identity: undefined as BigIntStats | undefined };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    assert(performance.now() < deadline, "Timed out waiting for live projection proof");
    await delay(5);
  }
}

async function createFixture() {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-live-projection-"));
  const store = new FlowRunStore(runsDir);
  const runId = "synthetic-held-compute";
  const T0 = "2026-01-01T00:00:00.000Z";
  const state: FlowRunState = {
    runId,
    flowName: runId,
    startedAt: T0,
    updatedAt: T0,
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    sessionBindings: {},
    currentNode: "hold",
    currentAttemptId: "hold#1",
    currentNodeType: "compute",
    currentNodeStartedAt: T0,
    lastHeartbeatAt: T0,
  };
  const flow = defineFlow({
    name: runId,
    startAt: "hold",
    nodes: { hold: compute({ run: () => ({}) }) },
    edges: [],
  });
  const runDir = await store.createRunDir(runId);
  await store.initializeRunBundle(runDir, { flow, state });
  const runPath = path.join(runDir, "projections/run.json");
  const storedRun = await fs.readFile(runPath);
  return {
    runsDir,
    runId,
    runDir,
    runPath,
    storedRun,
    T0,
    async heartbeat() {
      state.lastHeartbeatAt = new Date().toISOString();
      await store.writeLive(runDir, state, {
        scope: "node",
        type: "node_heartbeat",
        nodeId: "hold",
        attemptId: "hold#1",
        payload: {},
      });
      return state.updatedAt;
    },
    async close() {
      store.releaseRun(runDir);
      await fs.rm(runsDir, { recursive: true, force: true });
    },
  };
}
