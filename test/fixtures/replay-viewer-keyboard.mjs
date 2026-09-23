import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { StepTimeline } from "../../examples/flows/replay-viewer/src/components/step-timeline.tsx";
import { usePlaybackController } from "../../examples/flows/replay-viewer/src/hooks/use-playback-controller.ts";
import { playbackSelectionMs } from "../../examples/flows/replay-viewer/src/lib/view-model-playback.ts";

const scenario = process.argv[2];
const observations = [];
const arrowDirection = (key) => (["ArrowRight", "ArrowUp"].includes(key) ? 1 : -1);
const isArrow = (key) => ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key);

function makeBundle(count = 4) {
  const at = "2026-01-01T00:00:00.000Z";
  const steps = Array.from({ length: count }, (_, index) => ({
    attemptId: `compute_${index}#1`,
    nodeId: `compute_${index}`,
    nodeType: "compute",
    outcome: "ok",
    startedAt: at,
    finishedAt: "2026-01-01T00:00:01.000Z",
    promptText: null,
    rawText: null,
    output: null,
    session: null,
    agent: null,
  }));
  return {
    sourceType: "recent",
    sourceLabel: "Keyboard scrubber fixture",
    manifest: {
      schema: "acpx.flow-run-bundle.v1",
      runId: "keyboard-run",
      flowName: "keyboard-fixture",
      startedAt: at,
      status: "completed",
      traceSchema: "acpx.flow-trace-event.v1",
      paths: {
        flow: "flow.json",
        trace: "trace.ndjson",
        runProjection: "projections/run.json",
        liveProjection: "projections/live.json",
        stepsProjection: "projections/steps.json",
        sessionsDir: "sessions",
        artifactsDir: "artifacts",
      },
      sessions: [],
    },
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "keyboard-fixture",
      startAt: "compute_0",
      nodes: Object.fromEntries(
        Array.from({ length: Math.max(count, 1) }, (_, index) => [
          `compute_${index}`,
          { nodeType: "compute" },
        ]),
      ),
      edges: steps.slice(1).map((step, index) => ({ from: `compute_${index}`, to: step.nodeId })),
    },
    run: {
      runId: "keyboard-run",
      flowName: "keyboard-fixture",
      startedAt: at,
      updatedAt: at,
      status: "completed",
      input: {},
      outputs: {},
      results: {},
      steps,
      sessionBindings: {},
    },
    live: null,
    steps,
    trace: [],
    sessions: {},
  };
}

async function withTimeline(count, run) {
  const oldWindow = globalThis.window;
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const frames = new Map();
  let nextFrame = 0;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = {
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  const bundle = makeBundle(count);
  let playback;
  let renderer;
  function Component() {
    playback = usePlaybackController(bundle);
    const value =
      playback.playbackPreview?.playheadMs ??
      playbackSelectionMs(
        playback.playbackTimeline,
        playback.selectedStepIndex,
        bundle.steps.length,
      );
    return createElement(StepTimeline, {
      steps: bundle.steps,
      selectedIndex: playback.effectiveStepIndex,
      playbackValue: value,
      playbackMax: playback.playbackTimeline.totalDurationMs,
      playbackRate: playback.playbackRate,
      playbackSpeedOptions: [1, 2, 5, 10],
      currentNodeLabel: `compute_${playback.effectiveStepIndex}`,
      currentMeta: "synthetic",
      playing: playback.isPlaying,
      onSelect: playback.selectStep,
      onPlay: playback.play,
      onPause: playback.pause,
      onReset: playback.reset,
      onJumpToEnd: playback.jumpToEnd,
      onSeekStart: playback.startSeek,
      onSeek: playback.seek,
      onSeekCommit: playback.commitSeek,
      onPlaybackRateChange: playback.setPlaybackRate,
    });
  }
  const input = () => renderer.root.findByType("input").props;
  const change = async (value) =>
    act(async () => input().onChange({ target: { value: String(value) } }));
  const snapshot = () => ({
    selected: playback.selectedStepIndex,
    active: playback.effectiveStepIndex,
    value: input().value,
    preview: playback.playbackPreview,
    playing: playback.isPlaying,
    label: input()["aria-label"],
    pendingFrames: frames.size,
  });
  async function keyDown(key, modifiers = {}, nativeValue) {
    let prevented = false;
    await act(async () =>
      input().onKeyDown?.({
        key,
        ...modifiers,
        preventDefault() {
          prevented = true;
        },
      }),
    );
    if (!prevented) {
      const current = input();
      if (nativeValue !== undefined) await change(nativeValue);
      else if (isArrow(key))
        await change(
          Math.min(
            current.max,
            Math.max(current.min, current.value + arrowDirection(key) * current.step),
          ),
        );
      else if (key === "Home") await change(current.min);
      else if (key === "End") await change(current.max);
    }
    return prevented;
  }
  async function keyUp(key, modifiers = {}) {
    await act(async () =>
      input().onKeyUp?.({ key, ...modifiers, target: { value: String(input().value) } }),
    );
  }
  async function tap(key) {
    const prevented = await keyDown(key);
    await keyUp(key);
    observations.push({ key, prevented, ...snapshot() });
    return prevented;
  }
  try {
    await act(async () => {
      renderer = create(createElement(Component));
    });
    await act(async () => playback.reset());
    await run({
      input,
      change,
      snapshot,
      tap,
      keyDown,
      keyUp,
      playback: () => playback,
      async update(fn) {
        await act(async () => fn(playback));
      },
      async frame(timestamp) {
        await act(async () => {
          for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(timestamp);
        });
      },
      async pointerDown() {
        await act(async () => input().onPointerDown());
      },
      async pointerUp() {
        await act(async () => input().onPointerUp({ target: { value: String(input().value) } }));
      },
      async blur() {
        await act(async () => input().onBlur({ target: { value: String(input().value) } }));
      },
      inputs: () => renderer.root.findAllByType("input").length,
    });
  } finally {
    try {
      await act(async () => renderer?.unmount());
      assert.equal(frames.size, 0);
    } finally {
      if (oldWindow === undefined) delete globalThis.window;
      else globalThis.window = oldWindow;
      if (oldAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      else globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
    }
  }
}

function assertSelection(harness, selected) {
  const state = harness.snapshot();
  assert.equal(state.selected, selected);
  assert.equal(state.active, selected);
  assert.equal(state.preview, null);
  assert.equal(state.playing, false);
  assert.equal(state.pendingFrames, 0);
  assert.equal(state.value, selected === 3 ? 2800 : selected * 700);
  assert.equal(state.label, `Replay position step ${selected + 1} of 4`);
}

const scenarios = {
  async "right-taps"(h) {
    for (const selected of [1, 2, 3, 3]) {
      await h.tap("ArrowRight");
      assertSelection(h, selected);
    }
  },
  async "left-taps"(h) {
    await h.update((p) => p.jumpToEnd());
    for (const selected of [2, 1, 0, 0]) {
      await h.tap("ArrowLeft");
      assertSelection(h, selected);
    }
  },
  async "vertical-arrows"(h) {
    assert.equal(await h.tap("ArrowUp"), true);
    assertSelection(h, 1);
    assert.equal(await h.tap("ArrowDown"), true);
    assertSelection(h, 0);
  },
  async "repeated-keydown"(h) {
    for (const selected of [1, 2, 3, 3]) {
      assert.equal(await h.keyDown("ArrowRight", { repeat: true }), true);
      assertSelection(h, selected);
    }
    await h.keyUp("ArrowRight");
    assertSelection(h, 3);
    await h.keyUp("Shift");
    await h.blur();
    assertSelection(h, 3);
  },
  async "playback-origin"(h) {
    await h.update((p) => p.play());
    await h.frame(0);
    await h.frame(1100);
    assert.equal(h.playback().selectedStepIndex, 0);
    assert.equal(h.playback().effectiveStepIndex, 1);
    assert.equal(h.playback().playbackPreview.nearestStepIndex, 2);
    await h.keyDown("ArrowRight");
    assertSelection(h, 2);
    await h.keyUp("ArrowRight");
    assertSelection(h, 2);
    await h.frame(5000);
    assertSelection(h, 2);
  },
  async "seek-origin"(h) {
    await h.pointerDown();
    await h.change(1100);
    assert.equal(h.playback().selectedStepIndex, 0);
    assert.equal(h.playback().effectiveStepIndex, 1);
    assert.equal(h.playback().playbackPreview.nearestStepIndex, 2);
    await h.keyDown("ArrowRight");
    assertSelection(h, 2);
    await h.keyUp("ArrowRight");
    assertSelection(h, 2);
    await h.pointerUp();
    await h.blur();
    assertSelection(h, 2);
  },
  async "non-seeking-keyup"(h) {
    await h.update((p) => p.play());
    await h.frame(0);
    await h.frame(1100);
    for (const key of ["Tab", "Shift", "Escape", "a"]) {
      await h.keyUp(key);
      assert.equal(h.playback().isPlaying, true);
      assert.equal(h.playback().playbackPreview.playheadMs, 1100);
      assert.equal(h.snapshot().pendingFrames, 1);
    }
    await h.frame(1200);
    assert.equal(h.playback().playbackPreview.playheadMs, 1200);
    await h.tap("ArrowRight");
    assertSelection(h, 2);
  },
  async "page-seek-keys"(h) {
    assert.equal(await h.keyDown("PageDown", {}, 700), false);
    await h.keyUp("PageDown");
    assertSelection(h, 1);
    assert.equal(await h.keyDown("PageUp", {}, 0), false);
    await h.keyUp("PageUp");
    assertSelection(h, 0);
  },
  async "pointer-home-end-blur"(h) {
    await h.pointerDown();
    await h.change(900);
    assert.equal(h.playback().playbackMode, "seeking");
    assert.equal(h.playback().playbackPreview.playheadMs, 900);
    await h.pointerUp();
    assertSelection(h, 1);
    await h.tap("End");
    assertSelection(h, 3);
    await h.tap("Home");
    assertSelection(h, 0);
    await h.pointerDown();
    await h.change(900);
    await h.blur();
    assertSelection(h, 1);
  },
  async "modifier-keyup"(h) {
    for (const [flag, key] of [
      ["altKey", "Alt"],
      ["ctrlKey", "Control"],
      ["metaKey", "Meta"],
      ["shiftKey", "Shift"],
    ]) {
      await h.update((p) => p.reset());
      assert.equal(await h.keyDown("ArrowRight", { [flag]: true }, 700), false);
      await h.keyUp(key);
      await h.keyUp("ArrowRight", { [flag]: false });
      assertSelection(h, 1);
      await h.keyUp("Unidentified");
      await h.blur();
      assertSelection(h, 1);
    }
  },
};
if (scenario === "empty-single") {
  await withTimeline(0, async (h) => assert.equal(h.inputs(), 0));
  await withTimeline(1, async (h) => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      await h.tap(key);
      assert.equal(h.snapshot().selected, 0);
      assert.equal(h.snapshot().value, 700);
    }
  });
} else {
  assert.equal(typeof scenarios[scenario], "function", "known scenario required");
  await withTimeline(4, scenarios[scenario]);
}
process.stdout.write(JSON.stringify({ scenario, ok: true, observations }) + "\n");
