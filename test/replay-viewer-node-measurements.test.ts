import assert from "node:assert/strict";
import test from "node:test";
import { ReactFlowProvider, useStoreApi, type Node, type NodeChange } from "@xyflow/react";
import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { useNodeMeasurements } from "../examples/flows/replay-viewer/src/hooks/use-node-measurements.js";

type TestNode = Node<{ progress: number }>;
type MeasuredNodes = ReturnType<typeof useNodeMeasurements<TestNode>>;
type FlowStore = ReturnType<typeof useStoreApi<TestNode>>;
type Harness = {
  current: () => MeasuredNodes;
  store: () => FlowStore;
  change: (changes: NodeChange<TestNode>[]) => Promise<void>;
  update: (nodes: TestNode[], runId?: string) => Promise<void>;
};

test("graph dimensions survive fresh controlled playback nodes without freezing their data", async () => {
  const original = makeNodes(0);
  const before = structuredClone(original);
  await withMeasuredNodes(original, async (harness) => {
    assert.equal(harness.store().getState().nodesInitialized, false);
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 164 } },
      { type: "dimensions", id: "last", dimensions: { width: 264, height: 138 } },
    ]);
    const callback = harness.current().onNodesChange;
    for (let frame = 1; frame <= 12; frame += 1) {
      const next = makeNodes(frame / 12);
      await harness.update(next);
      const state = harness.store().getState();
      assert.equal(state.nodesInitialized, true);
      assert.deepEqual(state.nodeLookup.get("first")?.measured, { width: 264, height: 164 });
      assert.deepEqual(state.nodeLookup.get("last")?.measured, { width: 264, height: 138 });
      assert.equal(state.nodeLookup.get("first")?.data.progress, frame / 12);
      assert.deepEqual(state.nodeLookup.get("first")?.position, next[0]?.position);
      assert.equal(harness.current().onNodesChange, callback);
      assert.equal(next[0]?.measured, undefined);
      assert.equal(harness.current().nodes[0]?.width, undefined);
      assert.equal(harness.current().nodes[0]?.height, undefined);
    }
  });
  assert.deepEqual(original, before);
});

test("later dimension callbacks replace earlier measurements", async () => {
  await withMeasuredNodes(makeNodes(0), async (harness) => {
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 164 } },
    ]);
    const firstMeasurement = harness.current().nodes[0]?.measured;
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 164 } },
    ]);
    assert.equal(harness.current().nodes[0]?.measured, firstMeasurement);
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 192 } },
    ]);
    await harness.update(makeNodes(0.5));
    assert.deepEqual(harness.store().getState().nodeLookup.get("first")?.measured, {
      width: 264,
      height: 192,
    });
    assert.notEqual(harness.current().nodes[0]?.measured, firstMeasurement);
  });
});

test("measurement ownership leaves projected selection, position and membership intact", async () => {
  const nodes = makeNodes(0);
  await withMeasuredNodes(nodes, async (harness) => {
    await harness.change([
      { type: "select", id: "first", selected: true },
      { type: "position", id: "first", position: { x: 999, y: 999 } },
      { type: "remove", id: "last" },
      { type: "dimensions", id: "first" },
    ]);
    assert.deepEqual(harness.current().nodes, nodes);
    assert.equal(harness.store().getState().nodesInitialized, false);
  });
});

test("a new keyed run measures reused node ids independently", async () => {
  await withMeasuredNodes(makeNodes(0), async (harness) => {
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 164 } },
      { type: "dimensions", id: "last", dimensions: { width: 264, height: 138 } },
    ]);
    await harness.update(makeNodes(0), "second-run");
    assert.equal(harness.current().nodes[0]?.measured, undefined);
    assert.equal(harness.current().nodes[1]?.measured, undefined);
    assert.equal(harness.store().getState().nodesInitialized, false);
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 290, height: 190 } },
      { type: "dimensions", id: "last", dimensions: { width: 290, height: 140 } },
    ]);
    assert.equal(harness.store().getState().nodesInitialized, true);
    assert.deepEqual(harness.current().nodes[0]?.measured, { width: 290, height: 190 });
  });
});

test("a replacement node starts unmeasured while retained nodes keep their dimensions", async () => {
  await withMeasuredNodes(makeNodes(0), async (harness) => {
    await harness.change([
      { type: "dimensions", id: "first", dimensions: { width: 264, height: 164 } },
      { type: "dimensions", id: "last", dimensions: { width: 264, height: 138 } },
    ]);
    const next = makeNodes(0.5);
    assert.ok(next[0]);
    next[0].id = "replacement";
    await harness.update(next);
    assert.equal(harness.store().getState().nodeLookup.has("first"), false);
    assert.equal(harness.current().nodes[0]?.measured, undefined);
    assert.deepEqual(harness.current().nodes[1]?.measured, { width: 264, height: 138 });
    assert.equal(harness.store().getState().nodesInitialized, false);
    await harness.change([
      { type: "dimensions", id: "replacement", dimensions: { width: 264, height: 208 } },
    ]);
    assert.equal(harness.store().getState().nodesInitialized, true);
    assert.deepEqual(harness.current().nodes[0]?.measured, { width: 264, height: 208 });
  });
});

async function withMeasuredNodes(
  initialNodes: TestNode[],
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let current: MeasuredNodes | undefined;
  let store: FlowStore | undefined;
  let renderer: ReturnType<typeof create> | undefined;
  let currentRunId = "first-run";
  function Component({ nodes }: { nodes: TestNode[] }) {
    current = useNodeMeasurements(nodes);
    store = useStoreApi<TestNode>();
    const measured = current;
    const flowStore = store;
    useEffect(() => {
      // Exercise the installed React Flow controlled store's adoption and callback path.
      flowStore.setState({ onNodesChange: measured.onNodesChange });
      flowStore.getState().setNodes(measured.nodes);
    }, [flowStore, measured.nodes, measured.onNodesChange]);
    return createElement("div");
  }
  function element(nodes: TestNode[]) {
    return createElement(ReactFlowProvider, {
      key: currentRunId,
      children: createElement(Component, { nodes }),
    });
  }
  function read(): MeasuredNodes {
    assert.ok(current);
    return current;
  }
  function readStore(): FlowStore {
    assert.ok(store);
    return store;
  }
  try {
    await act(async () => {
      renderer = create(element(initialNodes));
    });
    await run({
      current: read,
      store: readStore,
      async change(changes) {
        await act(async () => readStore().getState().triggerNodeChanges(changes));
      },
      async update(nodes, runId = currentRunId) {
        currentRunId = runId;
        await act(async () => {
          assert.ok(renderer);
          renderer.update(element(nodes));
        });
      },
    });
  } finally {
    try {
      await act(async () => renderer?.unmount());
    } finally {
      if (previousActEnvironment === undefined) {
        delete globals.IS_REACT_ACT_ENVIRONMENT;
      } else {
        globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  }
}

function makeNodes(progress: number): TestNode[] {
  return [
    { id: "first", data: { progress }, position: { x: 20 + progress, y: 40 } },
    { id: "last", data: { progress: 0 }, position: { x: 20, y: 320 } },
  ];
}
