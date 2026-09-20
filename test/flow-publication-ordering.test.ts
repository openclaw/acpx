import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import { FlowRunner, compute, defineFlow } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import type { FlowRunState, FlowTraceEvent } from "../src/flows/types.js";

const HEARTBEAT_MS = 25;
const NODE_TIMEOUT_MS = 20_000;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function flushRunnableWork(): Promise<void> {
  // Drain runnable promise continuations; no elapsed-time assumption is involved.
  return new Promise((resolve) => setImmediate(resolve));
}

function makeRunner(outputRoot: string): FlowRunner {
  return new FlowRunner({
    outputRoot,
    permissionMode: "deny-all",
    resolveAgent: () => ({
      agentName: "unused",
      agentCommand: "unused",
      cwd: process.cwd(),
    }),
  });
}

function runStore(runner: FlowRunner): FlowRunStore {
  return (runner as unknown as { store: FlowRunStore }).store;
}

type Projection = {
  status: string;
  currentNode?: string;
  currentAttemptId?: string;
  finishedAt?: string;
};

async function readProjection(filePath: string): Promise<Projection> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Projection;
}

async function readTrace(runDir: string): Promise<FlowTraceEvent[]> {
  return (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FlowTraceEvent);
}

for (const relativePath of ["projections/live.json", "manifest.json"]) {
  for (const outcome of ["completion", "timeout"] as const) {
    test(
      `FlowRunner drains a held ${relativePath} heartbeat before ${outcome} publication`,
      { timeout: 10_000 },
      async (t) => {
        const outputRoot = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-publication-")),
        );
        const runner = makeRunner(outputRoot);
        const store = runStore(runner);
        const nodeEntered = deferred();
        const finishNode = deferred();
        const renameEntered = deferred();
        const releaseRename = deferred();
        const originalRename = fs.rename;
        const originalWriteSnapshot = store.writeSnapshot.bind(store);
        const originalWriteLive = store.writeLive.bind(store);
        const snapshotAdmissions: string[] = [];
        const heartbeatWrites: Promise<void>[] = [];
        let runDir: string | undefined;
        let armed = false;
        let held = false;
        let settled = false;

        t.mock.method(
          store,
          "writeSnapshot",
          (...args: Parameters<FlowRunStore["writeSnapshot"]>) => {
            runDir = args[0];
            snapshotAdmissions.push(args[2].type);
            return originalWriteSnapshot(...args);
          },
        );
        t.mock.method(store, "writeLive", (...args: Parameters<FlowRunStore["writeLive"]>) => {
          const write = originalWriteLive(...args);
          if (args[2].type === "node_heartbeat") {
            heartbeatWrites.push(write);
          }
          return write;
        });
        t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
          const [from, to] = args;
          const target = String(to);
          if (
            armed &&
            !held &&
            target.startsWith(`${outputRoot}${path.sep}`) &&
            target.endsWith(`${path.sep}${relativePath.split("/").join(path.sep)}`)
          ) {
            held = true;
            // Inspect the actual bytes already staged by the production store.
            const staged = await readProjection(String(from));
            assert.equal(staged.status, "running");
            assert.equal(staged.finishedAt, undefined);
            if (relativePath === "projections/live.json") {
              assert.equal(staged.currentNode, "work");
              assert.equal(staged.currentAttemptId, "work#1");
            }
            renameEntered.resolve();
            await releaseRename.promise;
          }
          await originalRename(...args);
        });
        t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

        const running = runner
          .run(
            defineFlow({
              name: "held-heartbeat-publication",
              startAt: "work",
              nodes: {
                work: compute({
                  timeoutMs: NODE_TIMEOUT_MS,
                  heartbeatMs: HEARTBEAT_MS,
                  run: async () => {
                    nodeEntered.resolve();
                    await finishNode.promise;
                    return null;
                  },
                }),
              },
              edges: [],
            }),
            {},
          )
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        void running.then(() => {
          settled = true;
        });

        try {
          await nodeEntered.promise;
          armed = true;
          t.mock.timers.tick(HEARTBEAT_MS);
          await renameEntered.promise;
          assert.equal(heartbeatWrites.length, 1);
          assert.ok(runDir);

          if (outcome === "completion") {
            finishNode.resolve();
          } else {
            t.mock.timers.tick(NODE_TIMEOUT_MS - HEARTBEAT_MS);
          }
          await flushRunnableWork();

          // Returning null avoids output-artifact I/O: absent draining, all work
          // before node_outcome admission is runnable promise continuation work.
          assert.deepEqual(snapshotAdmissions, ["node_started"]);
          assert.equal(settled, false, "the run must join the admitted heartbeat");
          const heldTrace = await readTrace(runDir);
          assert.deepEqual(
            heldTrace.map((event) => event.type),
            ["run_started", "node_started"],
          );

          releaseRename.resolve();
          const result = await running;
          await Promise.all(heartbeatWrites);
          const expectedStatus = outcome === "completion" ? "completed" : "timed_out";
          const terminalEvent = outcome === "completion" ? "run_completed" : "run_failed";
          if (outcome === "completion") {
            assert.equal(result.ok, true);
            if (result.ok) {
              assert.equal(result.value.state.status, expectedStatus);
            }
          } else {
            assert.equal(result.ok, false);
            if (!result.ok) {
              assert.ok(result.error instanceof TimeoutError);
            }
          }

          for (const file of ["projections/live.json", "manifest.json", "projections/run.json"]) {
            const projection = await readProjection(path.join(runDir, file));
            assert.equal(projection.status, expectedStatus, `${file} must remain terminal`);
            assert.equal(typeof projection.finishedAt, "string");
            assert.equal(projection.currentNode, undefined);
            assert.equal(projection.currentAttemptId, undefined);
          }
          const state = JSON.parse(
            await fs.readFile(path.join(runDir, "projections/run.json"), "utf8"),
          ) as FlowRunState;
          assert.equal(state.results.work?.outcome, outcome === "completion" ? "ok" : "timed_out");
          const trace = await readTrace(runDir);
          assert.deepEqual(
            trace.map((event) => event.type),
            ["run_started", "node_started", "node_heartbeat", "node_outcome", terminalEvent],
          );
          for (const event of trace.filter((entry) => entry.scope === "node")) {
            assert.equal(event.nodeId, "work");
            assert.equal(event.attemptId, "work#1");
          }
          assert.deepEqual(
            trace.map((event) => event.seq),
            [1, 2, 3, 4, 5],
          );
        } finally {
          releaseRename.resolve();
          finishNode.resolve();
          await running;
          await Promise.allSettled(heartbeatWrites);
          await fs.rm(outputRoot, { recursive: true, force: true });
        }
      },
    );
  }
}

test(
  "FlowRunner publishes node_started before admitting its first heartbeat",
  { timeout: 10_000 },
  async (t) => {
    const outputRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-start-order-")),
    );
    const runner = makeRunner(outputRoot);
    const store = runStore(runner);
    const snapshotEntered = deferred();
    const releaseSnapshot = deferred();
    const nodeEntered = deferred();
    const finishNode = deferred();
    const originalWriteSnapshot = store.writeSnapshot.bind(store);
    const originalWriteLive = store.writeLive.bind(store);
    const heartbeatWrites: Promise<void>[] = [];
    let callbackEntered = false;

    t.mock.method(
      store,
      "writeSnapshot",
      async (...args: Parameters<FlowRunStore["writeSnapshot"]>) => {
        if (args[2].type === "node_started") {
          snapshotEntered.resolve();
          await releaseSnapshot.promise;
        }
        await originalWriteSnapshot(...args);
      },
    );
    t.mock.method(store, "writeLive", (...args: Parameters<FlowRunStore["writeLive"]>) => {
      const write = originalWriteLive(...args);
      if (args[2].type === "node_heartbeat") {
        heartbeatWrites.push(write);
      }
      return write;
    });
    t.mock.timers.enable({ apis: ["setInterval"] });

    const running = runner
      .run(
        defineFlow({
          name: "first-heartbeat-order",
          startAt: "work",
          nodes: {
            work: compute({
              timeoutMs: NODE_TIMEOUT_MS,
              heartbeatMs: HEARTBEAT_MS,
              run: async () => {
                callbackEntered = true;
                nodeEntered.resolve();
                await finishNode.promise;
                return null;
              },
            }),
          },
          edges: [],
        }),
        {},
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    try {
      await snapshotEntered.promise;
      t.mock.timers.tick(HEARTBEAT_MS);
      await flushRunnableWork();
      assert.equal(callbackEntered, false);
      assert.equal(heartbeatWrites.length, 0, "heartbeats must wait for node_started publication");

      releaseSnapshot.resolve();
      await nodeEntered.promise;
      t.mock.timers.tick(HEARTBEAT_MS);
      assert.equal(heartbeatWrites.length, 1);
      await heartbeatWrites[0];
      finishNode.resolve();
      const result = await running;
      assert.equal(result.ok, true);
      const trace = await readTrace(result.value.runDir);
      assert.deepEqual(
        trace.map((event) => event.type),
        ["run_started", "node_started", "node_heartbeat", "node_outcome", "run_completed"],
      );
      const heartbeat = trace.find((event) => event.type === "node_heartbeat");
      assert.equal(heartbeat?.nodeId, "work");
      assert.equal(heartbeat?.attemptId, "work#1");
    } finally {
      releaseSnapshot.resolve();
      finishNode.resolve();
      await running;
      await Promise.allSettled(heartbeatWrites);
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  },
);
