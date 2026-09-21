import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AcpClient } from "../src/acp/client.js";
import { FlowRunner, checkpoint, compute, defineFlow } from "../src/flows/runtime.js";
import { FlowRunStore } from "../src/flows/store.js";
import type { FlowRunState, FlowSessionBinding } from "../src/flows/types.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-cache-"));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const runner = new FlowRunner({
    outputRoot,
    permissionMode: "deny-all",
    resolveAgent: () => ({ agentName: "unused", agentCommand: "unused", cwd: outputRoot }),
  });
  const store = (runner as unknown as { store: FlowRunStore }).store;
  return { outputRoot, runner, store };
}

function caches(store: FlowRunStore) {
  return store as unknown as {
    traceSeqByRun: Map<string, number>;
    manifestByRun: Map<string, unknown>;
    sessionSeqByBundle: Map<string, unknown>;
    appendChainByPath: Map<string, Promise<void>>;
  };
}

function assertReleased(store: FlowRunStore): void {
  const retained = caches(store);
  assert.equal(retained.traceSeqByRun.size, 0);
  assert.equal(retained.manifestByRun.size, 0);
  assert.equal(retained.sessionSeqByBundle.size, 0);
  assert.equal(retained.appendChainByPath.size, 0);
}

function simpleFlow() {
  return defineFlow({
    name: "repeated-compute",
    startAt: "work",
    nodes: { work: compute({ heartbeatMs: 0, run: ({ input }) => input }) },
    edges: [],
  });
}

test("FlowRunner releases each completed compute run while preserving its bundle", async (t) => {
  const { runner, store } = await fixture(t);
  for (let index = 0; index < 8; index++) {
    const result = await runner.run(simpleFlow(), { index });
    assert.equal(result.state.status, "completed");
    assert.deepEqual(result.state.outputs.work, { index });
    assertReleased(store);
    const saved = JSON.parse(
      await fs.readFile(path.join(result.runDir, "projections/run.json"), "utf8"),
    ) as FlowRunState;
    assert.equal(saved.status, "completed");
    assert.deepEqual(saved.outputs.work, { index });
  }
});

test("FlowRunStore releases only the selected run's sequence and manifest caches", async (t) => {
  const { outputRoot, store } = await fixture(t);
  const flow = simpleFlow();
  const binding: FlowSessionBinding = {
    key: "main",
    handle: "main",
    bundleId: "main",
    name: "main",
    agentName: "unused",
    agentCommand: "unused",
    cwd: outputRoot,
    acpxRecordId: "record",
    acpSessionId: "session",
  };
  const runDirs: string[] = [];
  for (const runId of ["run", "run-other"]) {
    const runDir = await store.createRunDir(runId);
    runDirs.push(runDir);
    await store.initializeRunBundle(runDir, {
      flow,
      state: {
        runId,
        flowName: flow.name,
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        input: {},
        outputs: {},
        results: {},
        steps: [],
        sessionBindings: {},
      },
    });
    assert.equal(
      await store.appendSessionEvent(runDir, binding, "inbound", {
        jsonrpc: "2.0",
        id: 1,
        result: {},
      }),
      1,
    );
  }
  const [first, second] = runDirs;
  store.releaseRun(first);
  assert.deepEqual([...caches(store).traceSeqByRun.keys()], [second]);
  assert.deepEqual([...caches(store).manifestByRun.keys()], [second]);
  assert.deepEqual([...caches(store).sessionSeqByBundle.keys()], [`${second}::main`]);
  assert.equal(
    await store.appendSessionEvent(second, binding, "inbound", {
      jsonrpc: "2.0",
      id: 2,
      result: {},
    }),
    2,
  );
  store.releaseRun(second);
  assertReleased(store);
});

for (const boundary of ["artifact", "bundle"] as const) {
  test(`FlowRunner releases caches when initial ${boundary} publication fails`, async (t) => {
    const { runner, store } = await fixture(t);
    const failure = new Error(`initial ${boundary} failed`);
    if (boundary === "artifact") {
      t.mock.method(store, "writeArtifact", async () => {
        throw failure;
      });
    } else {
      const initialize = store.initializeRunBundle.bind(store);
      t.mock.method(
        store,
        "initializeRunBundle",
        async (...args: Parameters<typeof initialize>) => {
          await initialize(...args);
          throw failure;
        },
      );
    }
    await assert.rejects(runner.run(simpleFlow(), {}), (error) => error === failure);
    assertReleased(store);
  });
}

for (const outcome of ["failed", "waiting"] as const) {
  test(`FlowRunner releases caches after a ${outcome} run`, async (t) => {
    const { runner, store } = await fixture(t);
    const failure = new Error("compute failed");
    const flow = defineFlow({
      name: `cache-${outcome}`,
      startAt: "work",
      nodes: {
        work:
          outcome === "waiting"
            ? checkpoint({ heartbeatMs: 0, summary: "Review the result" })
            : compute({
                heartbeatMs: 0,
                run: () => {
                  throw failure;
                },
              }),
      },
      edges: [],
    });
    if (outcome === "failed") {
      await assert.rejects(runner.run(flow, {}), (error) => error === failure);
    } else {
      assert.equal((await runner.run(flow, {})).state.status, "waiting");
    }
    assertReleased(store);
  });
}

test("FlowRunner preserves another run's caches until final publication settles", async (t) => {
  const { runner, store } = await fixture(t);
  const entered = gate();
  const publication = gate();
  const write = store.writeSnapshot.bind(store);
  let heldRunDir: string | undefined;
  t.mock.method(store, "writeSnapshot", async (...args: Parameters<typeof write>) => {
    if (args[2].type === "run_completed" && !heldRunDir) {
      heldRunDir = args[0];
      entered.release();
      await publication.promise;
    }
    await write(...args);
  });
  const running = runner.run(simpleFlow(), "held");
  try {
    await entered.promise;
    const completed = await runner.run(simpleFlow(), "independent");
    assert.notEqual(completed.runDir, heldRunDir);
    assert.deepEqual([...caches(store).traceSeqByRun.keys()], [heldRunDir]);
    assert.deepEqual([...caches(store).manifestByRun.keys()], [heldRunDir]);
    publication.release();
    const result = await running;
    assert.equal(result.state.status, "completed");
    assertReleased(store);
    const trace = (await fs.readFile(path.join(result.runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number });
    assert.deepEqual(
      trace.map((event) => event.seq),
      trace.map((_, index) => index + 1),
    );
  } finally {
    publication.release();
    await running;
  }
});

test("FlowRunner waits for every pending client close and releases caches after failure", async (t) => {
  const { outputRoot, runner, store } = await fixture(t);
  const clients = (
    runner as unknown as {
      pendingPersistentSessionClients: Map<string, Map<string, AcpClient>>;
    }
  ).pendingPersistentSessionClients;
  const closing = gate();
  const releaseClose = gate();
  const failure = new Error("first client close failed");
  const flow = defineFlow({
    name: "cleanup-failure",
    startAt: "work",
    nodes: {
      work: compute({
        heartbeatMs: 0,
        run: ({ state }) => {
          clients.set(
            path.join(outputRoot, state.runId),
            new Map([
              [
                "failed",
                {
                  close: async () => {
                    throw failure;
                  },
                } as unknown as AcpClient,
              ],
              [
                "held",
                {
                  close: async () => {
                    closing.release();
                    await releaseClose.promise;
                  },
                } as unknown as AcpClient,
              ],
            ]),
          );
          return null;
        },
      }),
    },
    edges: [],
  });
  let settled = false;
  const result = runner.run(flow, {}).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await closing.promise;
    await nextTurn();
    assert.equal(settled, false, "a failed close must not release a sibling's cleanup ownership");
    assert.equal(caches(store).traceSeqByRun.size, 1);
    assert.equal(caches(store).manifestByRun.size, 1);
    releaseClose.release();
    assert.equal(await result, failure);
    assertReleased(store);
  } finally {
    releaseClose.release();
    await result;
  }
});
