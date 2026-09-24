import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import {
  PLAYBACK_SPEED_OPTIONS,
  usePlaybackController,
} from "../examples/flows/replay-viewer/src/hooks/use-playback-controller.js";
import type { FlowStepRecord, LoadedRunBundle } from "../examples/flows/replay-viewer/src/types.js";

type Playback = ReturnType<typeof usePlaybackController>;
type Harness = {
  current: () => Playback;
  pendingFrames: () => number;
  frame: (timestamp: number) => Promise<void>;
  change: (update: (playback: Playback) => void) => Promise<void>;
  update: (bundle: LoadedRunBundle | null) => Promise<void>;
};

for (const rate of PLAYBACK_SPEED_OPTIONS) {
  test(`playback hook accounts for every animation interval at ${rate}x`, async () => {
    await withPlayback(makeBundle(), async (harness) => {
      await harness.change((playback) => {
        playback.setPlaybackRate(rate);
        playback.play();
      });
      for (let timestamp = 0; timestamp <= 200; timestamp += 20) {
        await harness.frame(timestamp);
        assert.equal(harness.current().playbackPreview?.playheadMs, timestamp * rate);
        assert.equal(harness.pendingFrames(), 1);
      }
    });
  });
}

test("playback hook retains elapsed time across equivalent same-run bundle updates", async () => {
  const bundle = makeBundle();
  await withPlayback(bundle, async (harness) => {
    await harness.change((playback) => playback.play());
    await harness.frame(0);
    await harness.frame(40);
    assert.equal(harness.current().playbackPreview?.playheadMs, 40);

    await harness.update(structuredClone(bundle));
    await harness.frame(60);
    assert.equal(harness.current().playbackPreview?.playheadMs, 60);
    assert.equal(harness.pendingFrames(), 1);
  });
});

test("playback hook preserves its clock while a same-run append extends the end", async () => {
  await withPlayback(makeBundle(2), async (harness) => {
    await harness.change((playback) => playback.play());
    await harness.frame(0);
    await harness.frame(1_300);
    assert.equal(harness.current().playbackTimeline?.totalDurationMs, 1_400);
    assert.equal(harness.current().playbackPreview?.playheadMs, 1_300);

    await harness.update(makeBundle(3));
    await harness.frame(1_500);
    assert.equal(harness.current().playbackPreview?.playheadMs, 1_500);
    assert.equal(harness.current().isPlaying, true);
    assert.equal(harness.current().playbackTimeline?.totalDurationMs, 2_100);

    await harness.frame(2_200);
    assert.equal(harness.current().isPlaying, false);
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.current().selectedStepIndex, 2);
    assert.equal(harness.pendingFrames(), 0);
  });
});

test("playback rate changes and paused replay start new clock intervals", async () => {
  await withPlayback(makeBundle(), async (harness) => {
    await harness.change((playback) => playback.play());
    await harness.frame(0);
    await harness.frame(20);
    assert.equal(harness.current().playbackPreview?.playheadMs, 20);

    await harness.change((playback) => playback.setPlaybackRate(2));
    await harness.frame(1_000);
    assert.equal(harness.current().playbackPreview?.playheadMs, 20);
    await harness.frame(1_020);
    assert.equal(harness.current().playbackPreview?.playheadMs, 60);

    await harness.change((playback) => playback.pause());
    assert.equal(harness.current().selectedStepIndex, 0);
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.pendingFrames(), 0);
    await harness.frame(9_000);

    await harness.change((playback) => playback.play());
    await harness.frame(10_000);
    assert.equal(harness.current().playbackPreview?.playheadMs, 0);
    await harness.frame(10_020);
    assert.equal(harness.current().playbackPreview?.playheadMs, 40);
  });
});

test("playback seek commits the nearest discrete step and stops the old frame loop", async () => {
  await withPlayback(makeBundle(), async (harness) => {
    await harness.change((playback) => playback.play());
    await harness.frame(0);
    await harness.frame(20);
    await harness.change((playback) => playback.startSeek());
    assert.equal(harness.current().playbackMode, "seeking");
    assert.equal(harness.pendingFrames(), 0);

    await harness.change((playback) => playback.seek(900));
    assert.equal(harness.current().playbackPreview?.playheadMs, 900);
    await harness.change((playback) => playback.commitSeek(900));
    assert.equal(harness.current().selectedStepIndex, 1);
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.pendingFrames(), 0);

    await harness.change((playback) => playback.play());
    await harness.frame(1_000);
    assert.equal(harness.current().playbackPreview?.playheadMs, 700);
    await harness.frame(1_020);
    assert.equal(harness.current().playbackPreview?.playheadMs, 720);
  });
});

const stopCases: Array<{
  name: string;
  apply: (playback: Playback) => void;
  selectedIndex: number;
}> = [
  { name: "step selection", apply: (playback) => playback.selectStep(1), selectedIndex: 1 },
  { name: "reset", apply: (playback) => playback.reset(), selectedIndex: 0 },
  { name: "jump to end", apply: (playback) => playback.jumpToEnd(), selectedIndex: 3 },
];
for (const entry of stopCases) {
  test(`playback ${entry.name} cancels its pending frame`, async () => {
    await withPlayback(makeBundle(), async (harness) => {
      await harness.change((playback) => playback.play());
      await harness.frame(0);
      await harness.frame(20);
      await harness.change(entry.apply);
      assert.equal(harness.current().selectedStepIndex, entry.selectedIndex);
      assert.equal(harness.current().isPlaying, false);
      assert.equal(harness.current().playbackPreview, null);
      assert.equal(harness.pendingFrames(), 0);
    });
  });
}

test("replacement and absent bundles retire the old playback clock", async () => {
  await withPlayback(makeBundle(), async (harness) => {
    await harness.change((playback) => {
      playback.setPlaybackRate(2);
      playback.play();
    });
    await harness.frame(0);
    await harness.frame(20);
    await harness.update(makeBundle(4, "replacement-run"));
    assert.equal(harness.current().isPlaying, false);
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.current().selectedStepIndex, 3);
    assert.equal(harness.current().playbackRate, 2);
    assert.equal(harness.pendingFrames(), 0);

    await harness.change((playback) => playback.play());
    await harness.frame(1_000_000);
    assert.equal(harness.current().playbackPreview?.playheadMs, 0);
    await harness.frame(1_000_020);
    assert.equal(harness.current().playbackPreview?.playheadMs, 40);

    await harness.update(null);
    assert.equal(harness.current().isPlaying, false);
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.pendingFrames(), 0);
  });
});

test("empty playback schedules no animation frame", async () => {
  await withPlayback(makeBundle(0), async (harness) => {
    await harness.change((playback) => playback.play());
    assert.equal(harness.current().playbackPreview, null);
    assert.equal(harness.pendingFrames(), 0);
  });
});

async function withPlayback(
  initialBundle: LoadedRunBundle | null,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousWindow = globals.window;
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const frames = new Map<number, (timestamp: number) => void>();
  let nextFrame = 0;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.window = {
    requestAnimationFrame(callback: (timestamp: number) => void) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };

  let current: Playback | undefined;
  let renderer: ReturnType<typeof create> | undefined;
  function Component({ bundle }: { bundle: LoadedRunBundle | null }) {
    current = usePlaybackController(bundle);
    return createElement("div");
  }
  function read(): Playback {
    assert.ok(current);
    return current;
  }
  try {
    await act(async () => {
      renderer = create(createElement(Component, { bundle: initialBundle }));
    });
    await run({
      current: read,
      pendingFrames: () => frames.size,
      async frame(timestamp) {
        await act(async () => {
          // Callbacks queued during this frame belong to the next browser frame.
          const pending = [...frames];
          for (const [id, callback] of pending) {
            if (frames.delete(id)) {
              callback(timestamp);
            }
          }
        });
      },
      async change(update) {
        await act(async () => update(read()));
      },
      async update(bundle) {
        await act(async () => {
          assert.ok(renderer);
          renderer.update(createElement(Component, { bundle }));
        });
      },
    });
  } finally {
    try {
      await act(async () => renderer?.unmount());
      assert.equal(frames.size, 0, "unmount must cancel pending animation work");
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

function makeBundle(stepCount = 4, runId = "clock-run"): LoadedRunBundle {
  const at = "2026-01-01T00:00:00.000Z";
  const steps = Array.from({ length: stepCount }, (_, index): FlowStepRecord => ({
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
    sourceLabel: "Playback clock",
    manifest: {
      schema: "acpx.flow-run-bundle.v1",
      runId,
      flowName: "playback-clock",
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
      name: "playback-clock",
      startAt: "compute_0",
      nodes: Object.fromEntries(
        Array.from({ length: Math.max(stepCount, 1) }, (_, index) => [
          `compute_${index}`,
          { nodeType: "compute" },
        ]),
      ),
      edges: steps.slice(1).map((step, index) => ({ from: `compute_${index}`, to: step.nodeId })),
    },
    run: {
      runId,
      flowName: "playback-clock",
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

test("later same-session answer growth preserves the active replay attempt and playhead", async () => {
  const bundle = makeAttemptGrowthBundle();
  const grown = structuredClone(bundle);
  const messages = grown.sessions["main-bundle"].record.messages;
  assert.ok(messages);
  messages[3] = { Agent: { content: [{ Text: "x".repeat(1_000) }], tool_results: {} } };

  await withPlayback(bundle, async (harness) => {
    await harness.change((playback) => playback.selectStep(0));
    await harness.change((playback) => playback.play());
    await harness.frame(0);
    await harness.frame(1_000);
    assert.equal(harness.current().playbackPreview?.playheadMs, 1_000);
    assert.equal(harness.current().effectiveStepIndex, 1);
    assert.equal(harness.current().isPlaying, true);
    assert.deepEqual(
      harness.current().playbackTimeline?.segments.map((segment) => segment.durationMs),
      [700, 700],
    );
    const completedSegment = structuredClone(harness.current().playbackTimeline?.segments[0]);
    assert.ok(completedSegment);

    await harness.update(grown);
    assert.equal(harness.current().playbackPreview?.playheadMs, 1_000);
    assert.equal(harness.current().effectiveStepIndex, 1);
    assert.equal(harness.current().isPlaying, true);
    assert.deepEqual(harness.current().playbackTimeline?.segments[0], completedSegment);
    assert.deepEqual(
      harness.current().playbackTimeline?.segments.map((segment) => segment.durationMs),
      [700, 3_420],
    );
    assert.equal(harness.current().playbackTimeline?.segments[1]?.startMs, 700);
    assert.equal(harness.pendingFrames(), 1);

    await harness.frame(1_040);
    assert.equal(harness.current().playbackPreview?.playheadMs, 1_040);
    assert.equal(harness.current().effectiveStepIndex, 1);
    assert.equal(harness.current().isPlaying, true);
    assert.equal(harness.pendingFrames(), 1);
  });
});

function makeAttemptGrowthBundle(): LoadedRunBundle {
  const bundle = makeBundle(0, "attempt-growth-run");
  const at = bundle.run.startedAt;
  const binding: NonNullable<FlowStepRecord["session"]> = {
    key: "attempt-growth:main",
    handle: "main",
    bundleId: "main-bundle",
    name: "main",
    agentName: "fixture",
    agentCommand: "fixture-agent",
    cwd: "/synthetic/attempt-growth",
    acpxRecordId: "attempt-growth-record",
    acpSessionId: "attempt-growth-native",
  };
  const steps = ["first_answer", "second_answer"].map((nodeId, index): FlowStepRecord => ({
    attemptId: `${nodeId}#1`,
    nodeId,
    nodeType: "acp",
    outcome: "ok",
    startedAt: at,
    finishedAt: at,
    promptText: index === 0 ? "First prompt" : "Second prompt",
    rawText: null,
    output: null,
    session: binding,
    agent: { agentName: binding.agentName, agentCommand: binding.agentCommand, cwd: binding.cwd },
    trace: {
      sessionId: binding.bundleId,
      conversation: {
        sessionId: binding.bundleId,
        messageStart: index * 2,
        messageEnd: index * 2 + 1,
        eventStartSeq: index * 3 + 1,
        eventEndSeq: index * 3 + 3,
      },
    },
  }));
  bundle.steps = steps;
  bundle.run.steps = steps;
  bundle.run.sessionBindings = { main: binding };
  bundle.flow.startAt = "first_answer";
  bundle.flow.nodes = {
    first_answer: {
      nodeType: "acp",
      hasPrompt: true,
      session: { handle: "main" },
      cwd: { mode: "default" },
    },
    second_answer: {
      nodeType: "acp",
      hasPrompt: true,
      session: { handle: "main" },
      cwd: { mode: "default" },
    },
  };
  bundle.flow.edges = [{ from: "first_answer", to: "second_answer" }];
  bundle.manifest.sessions = [
    {
      id: binding.bundleId,
      handle: binding.handle,
      bindingPath: "sessions/main/binding.json",
      recordPath: "sessions/main/record.json",
      eventsPath: "sessions/main/events.ndjson",
    },
  ];
  bundle.sessions = {
    [binding.bundleId]: {
      id: binding.bundleId,
      binding,
      record: {
        acpxRecordId: binding.acpxRecordId,
        acpSessionId: binding.acpSessionId,
        cwd: binding.cwd,
        agentCommand: binding.agentCommand,
        name: binding.name,
        messages: [
          { User: { id: "first-user", content: [{ Text: "First prompt" }] } },
          { Agent: { content: [{ Text: "FIRST-REPLY" }], tool_results: {} } },
          { User: { id: "second-user", content: [{ Text: "Second prompt" }] } },
          { Agent: { content: [{ Text: "x" }], tool_results: {} } },
        ],
      },
      events: [],
    },
  };
  return bundle;
}
