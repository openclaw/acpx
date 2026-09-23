import assert from "node:assert/strict";
import test from "node:test";
import type { InternalNode, Node, ReactFlowInstance } from "@xyflow/react";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import {
  REPLAY_FIT_VIEW_OPTIONS,
  useGraphCamera,
} from "../examples/flows/replay-viewer/src/hooks/use-graph-camera.js";

type Options = Parameters<typeof useGraphCamera>[0];
type Camera = ReturnType<typeof useGraphCamera>;
type CameraCall =
  | { kind: "center"; instance: string; x: number; y: number; zoom?: number; duration?: number }
  | { kind: "fit"; instance: string; options: Parameters<ReactFlowInstance["fitView"]>[0] };
type Harness = {
  install: (instance: ReactFlowInstance | null) => Promise<void>;
  update: (options: Options) => Promise<void>;
  flush: () => Promise<void>;
  pending: () => number;
  nextCallback: () => FrameRequestCallback;
};
const position = { x: 900, y: 1300 };
const options: Options = {
  runId: "run-a",
  layoutKey: "target:900:1300",
  currentNodeId: "target",
  currentNodePosition: position,
  viewMode: "follow",
};

function makeInstance(
  name: string,
  calls: CameraCall[],
  initialized = true,
  node?: InternalNode,
): ReactFlowInstance {
  const instance: Pick<
    ReactFlowInstance,
    "viewportInitialized" | "getInternalNode" | "setCenter" | "fitView"
  > = {
    viewportInitialized: initialized,
    getInternalNode: () => node,
    async setCenter(x, y, settings) {
      calls.push({
        kind: "center",
        instance: name,
        x,
        y,
        zoom: settings?.zoom,
        duration: settings?.duration,
      });
      return true;
    },
    async fitView(settings) {
      calls.push({ kind: "fit", instance: name, options: settings });
      return true;
    },
  };
  return instance as ReactFlowInstance;
}
function expectedCenter(name: string, x = 1042, y = 1439): CameraCall {
  return { kind: "center", instance: name, x, y, zoom: 0.84, duration: 320 };
}

test("run-switch replacement owns the center frame cancelled on the old viewport", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("a")]);
    await h.update({ ...options, runId: "run-b" });
    assert.equal(h.pending(), 1);
    const retired = h.nextCallback();
    await h.install(makeInstance("b", calls));
    assert.equal(h.pending(), 1, "replacement needs its own pending frame");
    await act(async () => retired(0));
    assert.deepEqual(calls, [expectedCenter("a")]);
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("a"), expectedCenter("b")]);
  });
});

test("a replacement viewport centers an unchanged target after the previous frame ran", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    await h.flush();
    await h.install(makeInstance("b", calls));
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("a"), expectedCenter("b")]);
  });
});

test("a replacement before the initial frame never commands the retired viewport", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    const retired = h.nextCallback();
    await h.install(makeInstance("b", calls));
    await act(async () => retired(0));
    assert.deepEqual(calls, []);
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("b")]);
  });
});

test("stable App-style target props do not schedule camera work on ordinary rerenders", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    const queued = h.nextCallback();
    for (let index = 0; index < 8; index += 1) {
      await h.update({ ...options });
    }
    assert.equal(h.pending(), 1);
    assert.equal(h.nextCallback(), queued);
    await h.flush();
    for (let index = 0; index < 8; index += 1) {
      await h.update({ ...options });
    }
    assert.equal(h.pending(), 0);
    assert.deepEqual(calls, [expectedCenter("a")]);
  });
});

test("target changes cancel obsolete frames before centering the latest target", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    const retired = h.nextCallback();
    await h.update({
      ...options,
      currentNodeId: "next",
      layoutKey: "next:100:200",
      currentNodePosition: { x: 100, y: 200 },
    });
    await act(async () => retired(0));
    assert.deepEqual(calls, []);
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("a", 242, 339)]);
  });
});

test("overview fits replacement viewports and returning to follow centers once", async () => {
  const calls: CameraCall[] = [];
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    const retiredFollow = h.nextCallback();
    await h.update({ ...options, viewMode: "overview" });
    await act(async () => retiredFollow(0));
    assert.deepEqual(calls, []);
    await h.flush();
    assert.deepEqual(calls, [{ kind: "fit", instance: "a", options: REPLAY_FIT_VIEW_OPTIONS }]);
    await h.install(makeInstance("b", calls));
    await h.flush();
    assert.deepEqual(calls.at(-1), {
      kind: "fit",
      instance: "b",
      options: REPLAY_FIT_VIEW_OPTIONS,
    });
    await h.update(options);
    await h.flush();
    assert.deepEqual(calls.at(-1), expectedCenter("b"));
    assert.equal(calls.length, 3);
  });
});

test("ineligible camera inputs and an uninitialized viewport retain their guards", async () => {
  const calls: CameraCall[] = [];
  await withCamera({ ...options, runId: undefined }, async (h) => {
    assert.equal(h.pending(), 0);
    await h.install(makeInstance("not-ready", calls, false));
    await h.update(options);
    assert.equal(h.pending(), 0);
    await h.update({ ...options, currentNodeId: null });
    await h.install(makeInstance("ready", calls));
    assert.equal(h.pending(), 0);
    await h.update({ ...options, currentNodePosition: null });
    assert.equal(h.pending(), 0);
    await h.update({ ...options, runId: undefined });
    assert.equal(h.pending(), 0);
    await h.update(options);
    await h.install(null);
    assert.equal(h.pending(), 0);
    await h.flush();
    assert.deepEqual(calls, []);
  });
});

test("current measured dimensions keep priority over declared sizes and defaults", async () => {
  const calls: CameraCall[] = [];
  const userNode: Node = { id: "target", position, data: {}, width: 100, height: 100 };
  const measured: InternalNode = {
    ...userNode,
    measured: { width: 320, height: 180 },
    internals: { positionAbsolute: position, z: 0, userNode },
  };
  await withCamera(options, async (h) => {
    await h.install(makeInstance("measured", calls, true, measured));
    await h.flush();
    assert.deepEqual(calls, [expectedCenter("measured", 1060, 1462)]);
  });
});

test("unmount cancels pending camera work and ignores a retired callback", async () => {
  const calls: CameraCall[] = [];
  let retired: FrameRequestCallback | undefined;
  await withCamera(options, async (h) => {
    await h.install(makeInstance("a", calls));
    assert.equal(h.pending(), 1);
    retired = h.nextCallback();
  });
  assert(retired);
  retired(0);
  assert.deepEqual(calls, []);
});

async function withCamera(
  initial: Options,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousWindow = globals.window;
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let current: Camera | undefined;
  let renderer: ReturnType<typeof create> | undefined;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.window = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  function Component(props: Options) {
    current = useGraphCamera(props);
    return createElement("div");
  }
  function read(): Camera {
    assert(current);
    return current;
  }
  try {
    await act(async () => {
      renderer = create(createElement(Component, initial));
    });
    await run({
      async install(instance) {
        await act(async () => read().setFlowInstance(instance));
      },
      async update(next) {
        await act(async () => {
          assert(renderer);
          renderer.update(createElement(Component, next));
        });
      },
      async flush() {
        await act(async () => {
          const pendingFrames = [...frames];
          for (const [id, callback] of pendingFrames) {
            if (frames.delete(id)) {
              callback(0);
            }
          }
        });
      },
      pending: () => frames.size,
      nextCallback() {
        const callback = frames.values().next().value;
        assert(callback);
        return callback;
      },
    });
  } finally {
    try {
      await act(async () => renderer?.unmount());
      assert.equal(frames.size, 0);
    } finally {
      if (previousWindow === undefined) {
        delete globals.window;
      } else {
        globals.window = previousWindow;
      }
      if (previousActEnvironment === undefined) {
        delete globals.IS_REACT_ACT_ENVIRONMENT;
      } else {
        globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  }
}
