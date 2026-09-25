import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Dimensions } from "@xyflow/react";
import Elk, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { useGraphLayout } from "../examples/flows/replay-viewer/src/hooks/use-graph-layout.js";
import type { LoadedRunBundle } from "../examples/flows/replay-viewer/src/types.js";
import { withTimeout } from "../src/async-control.js";

type LayoutState = ReturnType<typeof useGraphLayout>;
type PendingLayout = {
  graph: ElkNode;
  resolve: (graph: ElkNode) => void;
  reject: (error: Error) => void;
};
type Harness = {
  state(): LayoutState;
  requests: PendingLayout[];
  measure(runId: string, dimensions: ReadonlyMap<string, Dimensions>): Promise<void>;
  update(bundle: LoadedRunBundle | null): Promise<void>;
  requested(count: number): Promise<void>;
  finish(index: number, generation: number): Promise<void>;
};

test("layout waits for complete usable measurements and ignores equal values or playback data", async (t) => {
  await withLayout(t, async (harness) => {
    assert.equal(harness.state().layout, null);
    assert.equal(harness.state().routesReady, false);
    await harness.measure("first-run", new Map([["first", { width: 264, height: 106 }]]));
    await harness.measure("first-run", sizes(Number.NaN));
    await harness.measure("first-run", sizes(0));
    assert.equal(harness.requests.length, 0);

    await harness.measure("first-run", sizes(106));
    await harness.requested(1);
    assert.deepEqual(
      harness.requests[0].graph.children?.map(({ width, height }) => ({ width, height })),
      [
        { width: 264, height: 106 },
        { width: 264, height: 134 },
      ],
    );
    await harness.finish(0, 1);
    const previous = harness.state().layout;
    assert.equal(harness.state().routesReady, true);

    const repeated = sizes(106);
    repeated.set("departed", { width: 1, height: 1 });
    await harness.measure("first-run", repeated);
    const playback = bundle("first-run");
    playback.run.updatedAt = "2026-09-25T02:00:00.000Z";
    await harness.update(playback);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.state().layout, previous);
    assert.equal(harness.state().routesReady, true);
  });
});

test("a resize retains positions while withholding stale routes, then replaces geometry together", async (t) => {
  await withLayout(t, async (harness) => {
    await harness.measure("first-run", sizes(106));
    await harness.requested(1);
    await harness.finish(0, 1);
    const previous = harness.state().layout;
    await harness.measure("first-run", sizes(219));
    await harness.requested(2);
    assert.equal(harness.state().layout, previous);
    assert.equal(harness.state().routesReady, false);
    await harness.finish(1, 2);
    assert.equal(harness.state().routesReady, true);
    assert.equal(harness.state().layout?.nodePositions.first.x, 2);
    assert.equal(harness.state().layout?.edgeRoutes["first->last-0-0"].points[0].x, 2);
  });
});

test("an older asynchronous layout cannot replace the latest measured generation", async (t) => {
  await withLayout(t, async (harness) => {
    await harness.measure("first-run", sizes(106));
    await harness.requested(1);
    await harness.measure("first-run", sizes(134));
    await harness.requested(2);
    await harness.finish(1, 2);
    const latest = harness.state().layout;
    await harness.finish(0, 1);
    assert.equal(harness.state().layout, latest);
    assert.equal(harness.state().layout?.nodePositions.first.x, 2);
    assert.equal(harness.state().routesReady, true);
  });
});

test("reused node IDs in another run cannot inherit old measurements or pending geometry", async (t) => {
  await withLayout(t, async (harness) => {
    await harness.measure("first-run", sizes(106));
    await harness.requested(1);
    await harness.update(bundle("second-run"));
    await harness.measure("first-run", sizes(500));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.state().layout, null);
    assert.equal(harness.state().routesReady, false);
    await harness.measure("second-run", sizes(219));
    await harness.requested(2);
    await harness.finish(0, 1);
    assert.equal(harness.state().layout, null);
    await harness.finish(1, 2);
    assert.equal(harness.state().layout?.nodePositions.first.x, 2);
    assert.equal(harness.state().routesReady, true);
    await harness.update(null);
    assert.equal(harness.state().layout, null);
    assert.equal(harness.state().routesReady, false);
  });
});

test("a failed replacement layout selects the existing fallback instead of stale routes", async (t) => {
  await withLayout(t, async (harness) => {
    await harness.measure("first-run", sizes(106));
    await harness.requested(1);
    await harness.finish(0, 1);
    await harness.measure("first-run", sizes(219));
    await harness.requested(2);
    await act(async () => harness.requests[1].reject(new Error("synthetic layout failure")));
    assert.equal(harness.state().layout, null);
    assert.equal(harness.state().routesReady, true);
  });
});

async function withLayout(t: TestContext, run: (harness: Harness) => Promise<void>): Promise<void> {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const requests: PendingLayout[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  t.mock.method(Elk.prototype, "layout", (graph: ElkNode) => {
    return new Promise<ElkNode>((resolve, reject) => {
      requests.push({ graph, resolve, reject });
      for (const waiter of waiters) {
        if (requests.length >= waiter.count) {
          waiter.resolve();
        }
      }
    });
  });
  let current: LayoutState | undefined;
  let renderer: ReturnType<typeof create> | undefined;
  function Component({ value }: { value: LoadedRunBundle | null }) {
    current = useGraphLayout(value);
    return createElement("div");
  }
  function state() {
    assert.ok(current);
    return current;
  }
  try {
    await act(async () => {
      renderer = create(createElement(Component, { value: bundle("first-run") }));
    });
    await run({
      state,
      requests,
      async measure(runId, dimensions) {
        await act(async () => state().onMeasurements(runId, dimensions));
      },
      async update(value) {
        await act(async () => {
          assert.ok(renderer);
          renderer.update(createElement(Component, { value }));
        });
      },
      async requested(count) {
        if (requests.length >= count) {
          return;
        }
        await withTimeout(new Promise<void>((resolve) => waiters.push({ count, resolve })), 2_000);
      },
      async finish(index, generation) {
        const request = requests[index];
        assert.ok(request);
        // These synthetic engine results test asynchronous ownership, not routing geometry.
        const completed = structuredClone(request.graph);
        for (const [index, node] of (completed.children ?? []).entries()) {
          node.x = generation;
          node.y = index * 100;
        }
        for (const edge of completed.edges ?? []) {
          edge.sections = [
            {
              id: "section",
              startPoint: { x: generation, y: 0 },
              endPoint: { x: generation, y: 100 },
            },
          ];
        }
        await act(async () => request.resolve(completed));
      },
    });
  } finally {
    await act(async () => renderer?.unmount());
    if (previous === undefined) {
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globals.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  }
}

function sizes(firstHeight: number): Map<string, Dimensions> {
  return new Map([
    ["first", { width: 264, height: firstHeight }],
    ["last", { width: 264, height: 134 }],
  ]);
}

function bundle(runId: string): LoadedRunBundle {
  const timestamp = "2026-09-25T00:00:00.000Z";
  return {
    sourceType: "sample",
    sourceLabel: "layout-lifecycle",
    manifest: {
      schema: "acpx.flow-run-bundle.v1",
      runId,
      flowName: "layout",
      startedAt: timestamp,
      status: "running",
      traceSchema: "acpx.flow-trace-event.v1",
      paths: {
        flow: "flow.json",
        trace: "trace.ndjson",
        runProjection: "run.json",
        liveProjection: "live.json",
        stepsProjection: "steps.json",
        sessionsDir: "sessions",
        artifactsDir: "artifacts",
      },
      sessions: [],
    },
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "layout",
      startAt: "first",
      nodes: { first: { nodeType: "compute" }, last: { nodeType: "compute" } },
      edges: [{ from: "first", to: "last" }],
    },
    run: {
      runId,
      flowName: "layout",
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
    },
    live: null,
    steps: [],
    trace: [],
    sessions: {},
  };
}
