import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import {
  useRunBundleLoader,
  type RunBundleLoaderDeps,
} from "../examples/flows/replay-viewer/src/hooks/use-run-bundle-loader.js";
import { buildViewerRunsState } from "../examples/flows/replay-viewer/src/lib/runs-state.js";
import type {
  LoadedRunBundle,
  ReplayServerMessage,
  RunBundleSummary,
  ViewerRunLiveState,
} from "../examples/flows/replay-viewer/src/types.js";

Object.assign(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }, {
  IS_REACT_ACT_ENVIRONMENT: true,
});

function createRenderer(element: Parameters<typeof create>[0]): ReturnType<typeof create> {
  const originalError = console.error;
  console.error = ((message?: unknown, ...args: unknown[]) => {
    if (typeof message === "string" && message.includes("react-test-renderer is deprecated")) {
      return;
    }
    originalError(message, ...args);
  }) as typeof console.error;

  try {
    return create(element);
  } finally {
    console.error = originalError;
  }
}

test("useRunBundleLoader bootstrap stays stable after recent-runs state updates", async () => {
  const run: RunBundleSummary = {
    runId: "2026-03-31T200000000Z-pr-triage-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    status: "running",
    startedAt: "2026-03-31T20:00:00.000Z",
    updatedAt: "2026-03-31T20:00:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-run",
  };
  const bundle = makeLoadedRunBundle(run);
  let listRecentRunsCalls = 0;
  let loadRunBundleCalls = 0;
  let renderedRuns = 0;
  let renderedRunId: string | null = null;

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => {
      listRecentRunsCalls += 1;
      return [run];
    },
    loadRunBundle: async () => {
      loadRunBundleCalls += 1;
      return bundle;
    },
  };

  function Harness() {
    const { bootstrap, recentRuns, bundle: loadedBundle } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRuns = recentRuns.length;
    renderedRunId = loadedBundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = createRenderer(createElement(Harness));
    await flushReactWork();
  });

  await act(async () => {
    await flushReactWork();
  });

  assert.equal(listRecentRunsCalls, 1);
  assert.equal(loadRunBundleCalls, 1);
  assert.equal(renderedRuns, 1);
  assert.equal(renderedRunId, run.runId);

  await act(async () => {
    renderer?.unmount();
    await flushReactWork();
  });
});

test("useRunBundleLoader ignores stale bootstrap results after a newer live runs snapshot", async () => {
  const run: RunBundleSummary = {
    runId: "2026-04-01T150000000Z-pr-triage-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-205",
    status: "running",
    startedAt: "2026-04-01T15:00:00.000Z",
    updatedAt: "2026-04-01T15:00:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-run",
  };
  const bundle = makeLoadedRunBundle(run);
  let resolveBootstrapRuns!: (runs: RunBundleSummary[]) => void;
  const bootstrapRuns = new Promise<RunBundleSummary[]>((resolve) => {
    resolveBootstrapRuns = resolve;
  });
  let loadRunBundleCalls = 0;
  let renderedRuns = 0;
  let renderedRunId: string | null = null;

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => bootstrapRuns,
    loadRunBundle: async () => {
      loadRunBundleCalls += 1;
      return bundle;
    },
  };

  const restoreBrowser = installFakeBrowser();

  function Harness() {
    const { bootstrap, recentRuns, bundle: loadedBundle } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRuns = recentRuns.length;
    renderedRunId = loadedBundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      renderer = createRenderer(createElement(Harness));
      await flushReactWork();
    });

    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket);

    await act(async () => {
      socket?.emitMessage({ type: "ready", protocol: "acpx.replay.v1" });
      socket?.emitMessage({
        type: "runs_snapshot",
        version: 1,
        state: buildViewerRunsState([run]),
      });
      await flushReactWork();
    });

    await act(async () => {
      await flushReactWork();
    });

    assert.equal(loadRunBundleCalls, 1);
    assert.equal(renderedRuns, 1);
    assert.equal(renderedRunId, run.runId);

    resolveBootstrapRuns([]);
    await act(async () => {
      await bootstrapRuns;
      await flushReactWork();
    });

    assert.equal(renderedRuns, 1);
    assert.equal(renderedRunId, run.runId);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreBrowser();
  }
});

test("useRunBundleLoader waits for recent runs instead of loading the bundled sample", async () => {
  let loadRunBundleCalls = 0;
  let renderedRuns = 0;
  let renderedRunId: string | null = "uninitialized";

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => [],
    loadRunBundle: async () => {
      loadRunBundleCalls += 1;
      throw new Error("loadRunBundle should not run when there are no recent runs");
    },
  };

  function Harness() {
    const { bootstrap, recentRuns, bundle: loadedBundle } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRuns = recentRuns.length;
    renderedRunId = loadedBundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = createRenderer(createElement(Harness));
    await flushReactWork();
  });

  await act(async () => {
    await flushReactWork();
  });

  assert.equal(loadRunBundleCalls, 0);
  assert.equal(renderedRuns, 0);
  assert.equal(renderedRunId, null);

  await act(async () => {
    renderer?.unmount();
    await flushReactWork();
  });
});

test("useRunBundleLoader auto-loads the first recent run when the list becomes non-empty", async () => {
  const run: RunBundleSummary = {
    runId: "2026-03-31T210000000Z-pr-triage-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-167",
    status: "running",
    startedAt: "2026-03-31T21:00:00.000Z",
    updatedAt: "2026-03-31T21:00:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-run",
  };
  const bundle = makeLoadedRunBundle(run);
  let currentRuns: RunBundleSummary[] = [];
  let refreshRunsRef: (() => Promise<RunBundleSummary[] | null>) | null = null;
  let loadRunBundleCalls = 0;
  let renderedRunId: string | null = "uninitialized";

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => currentRuns,
    loadRunBundle: async () => {
      loadRunBundleCalls += 1;
      return bundle;
    },
  };

  function Harness() {
    const { bootstrap, refreshRuns, bundle: loadedBundle } = useRunBundleLoader(deps);

    useEffect(() => {
      refreshRunsRef = refreshRuns;
      void bootstrap();
    }, [bootstrap, refreshRuns]);

    renderedRunId = loadedBundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = createRenderer(createElement(Harness));
    await flushReactWork();
  });

  await act(async () => {
    await flushReactWork();
  });

  assert.equal(loadRunBundleCalls, 0);
  assert.equal(renderedRunId, null);

  currentRuns = [run];
  await act(async () => {
    await refreshRunsRef?.();
    await flushReactWork();
  });

  await act(async () => {
    await flushReactWork();
  });

  assert.equal(loadRunBundleCalls, 1);
  assert.equal(renderedRunId, run.runId);

  await act(async () => {
    renderer?.unmount();
    await flushReactWork();
  });
});

test("useRunBundleLoader ignores stale recent-run loads when a newer live selection wins", async () => {
  const firstRun: RunBundleSummary = {
    runId: "2026-04-01T151000000Z-pr-triage-first",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-201",
    status: "running",
    startedAt: "2026-04-01T15:10:00.000Z",
    updatedAt: "2026-04-01T15:10:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-first",
  };
  const secondRun: RunBundleSummary = {
    runId: "2026-04-01T151100000Z-pr-triage-second",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-202",
    status: "running",
    startedAt: "2026-04-01T15:11:00.000Z",
    updatedAt: "2026-04-01T15:11:01.000Z",
    currentNode: "judge_solution",
    path: "/tmp/acpx-live-second",
  };
  const firstBundle = makeLoadedRunBundle(firstRun);
  const secondBundle = makeLoadedRunBundle(secondRun);
  let resolveFirstLoad!: (bundle: LoadedRunBundle) => void;
  let resolveSecondLoad!: (bundle: LoadedRunBundle) => void;
  const firstLoad = new Promise<LoadedRunBundle>((resolve) => {
    resolveFirstLoad = resolve;
  });
  const secondLoad = new Promise<LoadedRunBundle>((resolve) => {
    resolveSecondLoad = resolve;
  });
  let renderedRunId: string | null = null;
  let renderedRuns = 0;

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: (run) =>
      ({
        sourceType: "recent",
        label: run.runId,
      }) as never,
    listRecentRuns: async () => [firstRun],
    loadRunBundle: async (reader) => {
      if ((reader as { label?: string }).label === firstRun.runId) {
        return firstLoad;
      }
      if ((reader as { label?: string }).label === secondRun.runId) {
        return secondLoad;
      }
      throw new Error("Unexpected recent run reader");
    },
  };

  const restoreBrowser = installFakeBrowser();

  function Harness() {
    const { bootstrap, recentRuns, bundle } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRuns = recentRuns.length;
    renderedRunId = bundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      renderer = createRenderer(createElement(Harness));
      await flushReactWork();
    });

    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket);

    await act(async () => {
      socket?.emitMessage({ type: "ready", protocol: "acpx.replay.v1" });
      socket?.emitMessage({
        type: "runs_snapshot",
        version: 1,
        state: buildViewerRunsState([secondRun, firstRun]),
      });
      await flushReactWork();
    });

    await act(async () => {
      resolveSecondLoad(secondBundle);
      await secondLoad;
      await flushReactWork();
    });

    assert.equal(renderedRuns, 2);
    assert.equal(renderedRunId, secondRun.runId);

    await act(async () => {
      resolveFirstLoad(firstBundle);
      await firstLoad;
      await flushReactWork();
    });

    assert.equal(renderedRunId, secondRun.runId);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreBrowser();
  }
});

test("useRunBundleLoader resyncs runs when a live runs patch cannot be applied", async () => {
  const run: RunBundleSummary = {
    runId: "2026-04-01T180000000Z-pr-triage-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-205",
    status: "running",
    startedAt: "2026-04-01T18:00:00.000Z",
    updatedAt: "2026-04-01T18:00:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-run",
  };
  const bundle = makeLoadedRunBundle(run);
  let renderedRuns = 0;

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => [],
    loadRunBundle: async () => bundle,
  };

  const restoreBrowser = installFakeBrowser();

  function Harness() {
    const { bootstrap, recentRuns } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRuns = recentRuns.length;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      renderer = createRenderer(createElement(Harness));
      await flushReactWork();
    });

    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket);

    await act(async () => {
      socket?.emitMessage({ type: "ready", protocol: "acpx.replay.v1" });
      socket?.emitMessage({
        type: "runs_snapshot",
        version: 1,
        state: buildViewerRunsState([run]),
      });
      await flushReactWork();
    });

    assert.equal(renderedRuns, 1);

    await act(async () => {
      socket?.emitMessage({
        type: "runs_patch",
        fromVersion: 1,
        toVersion: 2,
        ops: [
          {
            op: "replace",
            path: "/runs/0/finishedAt",
            value: "2026-04-01T18:00:05.000Z",
          },
        ],
      });
      await flushReactWork();
    });

    assert.deepEqual(
      socket.sent.map((entry) => JSON.parse(entry) as { type: string }),
      [
        { type: "hello", protocol: "acpx.replay.v1" },
        { type: "subscribe_runs" },
        { type: "subscribe_run", runId: run.runId },
        { type: "resync_runs" },
      ],
    );
    assert.equal(renderedRuns, 1);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreBrowser();
  }
});

test("useRunBundleLoader resyncs the selected run when a live run patch cannot be applied", async () => {
  const run: RunBundleSummary = {
    runId: "2026-04-01T181000000Z-pr-triage-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-206",
    status: "running",
    startedAt: "2026-04-01T18:10:00.000Z",
    updatedAt: "2026-04-01T18:10:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-live-run-selected",
  };
  const bundle = makeLoadedRunBundle(run);
  let renderedRunId: string | null = null;

  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => [],
    loadRunBundle: async () => bundle,
  };

  const restoreBrowser = installFakeBrowser();

  function Harness() {
    const { bootstrap, bundle: loadedBundle } = useRunBundleLoader(deps);

    useEffect(() => {
      void bootstrap();
    }, [bootstrap]);

    renderedRunId = loadedBundle?.run.runId ?? null;
    return createElement("div");
  }

  let renderer: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      renderer = createRenderer(createElement(Harness));
      await flushReactWork();
    });

    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket);

    await act(async () => {
      socket?.emitMessage({ type: "ready", protocol: "acpx.replay.v1" });
      socket?.emitMessage({
        type: "runs_snapshot",
        version: 1,
        state: buildViewerRunsState([run]),
      });
      await flushReactWork();
    });

    await act(async () => {
      await flushReactWork();
    });

    assert.equal(renderedRunId, run.runId);

    await act(async () => {
      socket?.emitMessage({
        type: "run_patch",
        runId: run.runId,
        fromVersion: 1,
        toVersion: 2,
        ops: [
          {
            op: "replace",
            path: "/run/finishedAt",
            value: "2026-04-01T18:10:05.000Z",
          },
        ],
      });
      await flushReactWork();
    });

    assert.deepEqual(
      socket.sent.map((entry) => JSON.parse(entry) as { type: string; runId?: string }),
      [
        { type: "hello", protocol: "acpx.replay.v1" },
        { type: "subscribe_runs" },
        { type: "subscribe_run", runId: run.runId },
        { type: "resync_run", runId: run.runId },
      ],
    );
    assert.equal(renderedRunId, run.runId);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreBrowser();
  }
});

async function flushReactWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeLoadedRunBundle(run: RunBundleSummary): LoadedRunBundle {
  return {
    sourceType: "recent",
    sourceLabel: run.runTitle ?? run.flowName,
    manifest: {
      schema: "acpx.flow-run-bundle.v1",
      runId: run.runId,
      flowName: run.flowName,
      runTitle: run.runTitle,
      startedAt: run.startedAt,
      status: run.status,
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
      name: run.flowName,
      startAt: "extract_intent",
      nodes: {
        extract_intent: {
          nodeType: "acp",
          session: {
            handle: "main",
            isolated: false,
          },
        },
      },
      edges: [],
    },
    run: {
      runId: run.runId,
      flowName: run.flowName,
      runTitle: run.runTitle,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt ?? run.startedAt,
      status: run.status,
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
      currentNode: run.currentNode,
    },
    live: null,
    steps: [],
    trace: [],
    sessions: {},
  };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  emitMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function installFakeBrowser(): () => void {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.instances = [];

  const location = new URL("http://127.0.0.1:4173/");
  const history = {
    state: null,
    replaceState(_state: unknown, _title: string, nextLocation: string) {
      const next = new URL(nextLocation, location.href);
      location.href = next.href;
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  };

  (globalThis as { window?: unknown }).window = {
    location,
    history,
    setTimeout,
    clearTimeout,
  };
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

  return () => {
    FakeWebSocket.instances = [];
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
    if (previousWebSocket === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as { WebSocket?: unknown }).WebSocket = previousWebSocket;
    }
  };
}

const liveReadWarning = "Synthetic run files could not be read";
const recoveredLiveRunTitle = "Recovered live update";

for (const recovery of ["snapshot", "patch"] as const) {
  test(`useRunBundleLoader clears a run read warning after an accepted same-run ${recovery}`, async () => {
    await withLiveReadRecoveryLoader(async (context) => {
      await context.send({
        type: "error",
        code: "internal_error",
        runId: context.run.runId,
        message: liveReadWarning,
      });

      assert.equal(context.read().errorMessage, liveReadWarning);
      assert.equal(context.read().bundle?.run.runTitle, context.run.runTitle);

      await context.send(healthyLiveReadMessage(context, recovery));

      assert.equal(context.read().bundle?.run.runTitle, recoveredLiveRunTitle);
      assert.equal(context.read().activeRunId, context.run.runId);
      assert.equal(context.read().errorMessage, null);
    });
  });
}

test("useRunBundleLoader keeps a run read warning through unrelated or rejected live updates", async () => {
  await withLiveReadRecoveryLoader(async (context) => {
    const { run, state, socket, send, read } = context;
    await send({
      type: "error",
      code: "internal_error",
      runId: run.runId,
      message: liveReadWarning,
    });
    assert.equal(read().errorMessage, liveReadWarning);

    await send({
      type: "runs_snapshot",
      version: 2,
      state: buildViewerRunsState([{ ...run, runTitle: "Sidebar snapshot" }]),
    });
    assert.equal(read().recentRuns[0]?.runTitle, "Sidebar snapshot");
    assert.equal(read().errorMessage, liveReadWarning);

    await send({
      type: "runs_patch",
      fromVersion: 2,
      toVersion: 3,
      ops: [
        {
          op: "replace",
          path: `/runsById/${run.runId}/runTitle`,
          value: "Sidebar patch",
        },
      ],
    });
    assert.equal(read().recentRuns[0]?.runTitle, "Sidebar patch");
    assert.equal(read().errorMessage, liveReadWarning);

    const otherRun = { ...run, runId: `${run.runId}-other`, runTitle: "Other run" };
    await send({
      type: "run_snapshot",
      runId: otherRun.runId,
      version: 2,
      state: {
        ...makeLoadedRunBundle(otherRun),
        schema: "acpx.viewer-run-live.v1",
      },
    });
    assert.equal(read().activeRunId, run.runId);
    assert.deepEqual(read().bundle, state);
    assert.equal(read().errorMessage, liveReadWarning);

    await send({
      type: "run_patch",
      runId: otherRun.runId,
      fromVersion: 1,
      toVersion: 2,
      ops: [{ op: "replace", path: "/run/runTitle", value: "Wrong run patch" }],
    });
    assert.deepEqual(read().bundle, state);
    assert.equal(read().errorMessage, liveReadWarning);

    await send({
      type: "run_patch",
      runId: run.runId,
      fromVersion: 99,
      toVersion: 100,
      ops: [{ op: "replace", path: "/run/runTitle", value: "Wrong version patch" }],
    });
    assert.deepEqual(read().bundle, state);
    assert.equal(read().errorMessage, liveReadWarning);
    assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? "null"), {
      type: "resync_run",
      runId: run.runId,
    });

    const sentBeforeInvalidPatch = socket.sent.length;
    await send({
      type: "run_patch",
      runId: run.runId,
      fromVersion: 1,
      toVersion: 2,
      ops: [
        { op: "replace", path: "/run/runTitle", value: "Uncommitted partial patch" },
        { op: "replace", path: "/run/missingField", value: "Invalid replacement" },
      ],
    });
    assert.equal(socket.sent.length, sentBeforeInvalidPatch + 1);
    assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? "null"), {
      type: "resync_run",
      runId: run.runId,
    });
    assert.deepEqual(read().bundle, state);
    assert.equal(read().errorMessage, liveReadWarning);

    // Neither rejected patch may advance the accepted version or consume recovery.
    await send(healthyLiveReadMessage(context, "patch"));
    assert.equal(read().bundle?.run.runTitle, recoveredLiveRunTitle);
    assert.equal(read().errorMessage, null);
  });
});

for (const origin of [
  "global live error",
  "different live error code",
  "bootstrap failure",
  "different-run load failure",
] as const) {
  for (const recovery of ["snapshot", "patch"] as const) {
    test(`useRunBundleLoader preserves a ${origin} through a healthy same-run ${recovery}`, async () => {
      await withLiveReadRecoveryLoader(async (context) => {
        const { run, deps, send, read } = context;
        await send({
          type: "error",
          code: "internal_error",
          runId: run.runId,
          message: liveReadWarning,
        });
        assert.equal(read().errorMessage, liveReadWarning);

        // Reuse identical text to require origin tracking, not string matching.
        switch (origin) {
          case "global live error":
            await send({ type: "error", code: "internal_error", message: liveReadWarning });
            break;
          case "different live error code":
            await send({
              type: "error",
              code: "protocol_error",
              runId: run.runId,
              message: liveReadWarning,
            });
            break;
          case "bootstrap failure":
            deps.listRecentRuns = async () => {
              throw new Error(liveReadWarning);
            };
            await act(async () => {
              await read().bootstrap();
              await flushReactWork();
            });
            break;
          case "different-run load failure":
            deps.loadRunBundle = async () => {
              throw new Error(liveReadWarning);
            };
            await act(async () => {
              await read().loadRecentRun({ ...run, runId: `${run.runId}-other` });
              await flushReactWork();
            });
            break;
        }

        assert.equal(read().errorMessage, liveReadWarning);
        assert.equal(read().activeRunId, run.runId);
        assert.equal(read().bundle?.run.runTitle, run.runTitle);

        await send(healthyLiveReadMessage(context, recovery));

        assert.equal(read().bundle?.run.runTitle, recoveredLiveRunTitle);
        assert.equal(read().errorMessage, liveReadWarning);
      });
    });
  }
}

type LiveReadRecoveryTestContext = {
  run: RunBundleSummary;
  state: ViewerRunLiveState;
  deps: RunBundleLoaderDeps;
  socket: FakeWebSocket;
  read: () => ReturnType<typeof useRunBundleLoader>;
  send: (message: ReplayServerMessage) => Promise<void>;
};

function healthyLiveReadMessage(
  { run, state }: LiveReadRecoveryTestContext,
  recovery: "snapshot" | "patch",
): ReplayServerMessage {
  if (recovery === "snapshot") {
    return {
      type: "run_snapshot",
      runId: run.runId,
      version: 2,
      state: { ...state, run: { ...state.run, runTitle: recoveredLiveRunTitle } },
    };
  }
  return {
    type: "run_patch",
    runId: run.runId,
    fromVersion: 1,
    toVersion: 2,
    ops: [{ op: "replace", path: "/run/runTitle", value: recoveredLiveRunTitle }],
  };
}

async function withLiveReadRecoveryLoader(
  runCase: (context: LiveReadRecoveryTestContext) => Promise<void>,
): Promise<void> {
  const run: RunBundleSummary = {
    runId: "2026-09-22T100000000Z-synthetic-live-read-recovery",
    flowName: "synthetic-live-read-recovery",
    runTitle: "Before recovery",
    status: "running",
    startedAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:01.000Z",
    currentNode: "extract_intent",
    path: "/tmp/acpx-synthetic-live-read-recovery",
  };
  const bundle = makeLoadedRunBundle(run);
  const state: ViewerRunLiveState = { ...bundle, schema: "acpx.viewer-run-live.v1" };
  const deps: RunBundleLoaderDeps = {
    createRecentRunBundleReader: () => ({ source: "recent" }) as never,
    listRecentRuns: async () => [run],
    loadRunBundle: async () => bundle,
  };
  let current: ReturnType<typeof useRunBundleLoader> | null = null;
  const read = () => {
    assert.ok(current);
    return current;
  };
  function Harness() {
    const loader = useRunBundleLoader(deps);
    useEffect(() => {
      void loader.bootstrap();
    }, [loader.bootstrap]);
    current = loader;
    return createElement("div");
  }

  const restoreBrowser = installFakeBrowser();
  let renderer: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      renderer = createRenderer(createElement(Harness));
      await flushReactWork();
    });
    await act(async () => {
      await flushReactWork();
    });
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket);
    const send = async (message: ReplayServerMessage): Promise<void> => {
      await act(async () => {
        socket.emitMessage(message);
        await flushReactWork();
      });
    };
    await send({ type: "ready", protocol: "acpx.replay.v1" });
    await send({ type: "run_snapshot", runId: run.runId, version: 1, state });
    assert.equal(read().activeRunId, run.runId);
    assert.deepEqual(read().bundle, state);
    assert.equal(read().errorMessage, null);
    await runCase({ run, state, deps, socket, read, send });
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreBrowser();
  }
}

for (const scenario of ["stale success", "stale error", "repeat pending B"] as const) {
  test(`useRunBundleLoader honors selection intent after ${scenario}`, async () => {
    const runA: RunBundleSummary = {
      runId: "synthetic-selection-A",
      flowName: "selection-intent",
      runTitle: "Selection A",
      status: "completed",
      startedAt: "2026-09-22T10:00:00.000Z",
      path: "/synthetic/selection-A",
    };
    const runB: RunBundleSummary = {
      ...runA,
      runId: "synthetic-selection-B",
      runTitle: "Selection B",
      path: "/synthetic/selection-B",
    };
    const bundleA = makeLoadedRunBundle(runA);
    const bundleB = makeLoadedRunBundle(runB);
    let resolveB!: (bundle: LoadedRunBundle) => void;
    let rejectB!: (error: Error) => void;
    const firstB = new Promise<LoadedRunBundle>((resolve, reject) => {
      resolveB = resolve;
      rejectB = reject;
    });
    let loadsA = 0;
    let loadsB = 0;
    const deps: RunBundleLoaderDeps = {
      createRecentRunBundleReader: (run) => ({
        sourceType: "recent",
        label: run.runId,
        readText: async () => {
          throw new Error("Unexpected fixture file read");
        },
      }),
      listRecentRuns: async () => [],
      loadRunBundle: async (reader) => {
        if (reader.label === runA.runId) {
          loadsA += 1;
          return bundleA;
        }
        assert.equal(reader.label, runB.runId);
        loadsB += 1;
        return loadsB === 1 ? firstB : bundleB;
      },
    };
    let current: ReturnType<typeof useRunBundleLoader> | null = null;
    const read = () => {
      assert(current);
      return current;
    };
    const pathname = () =>
      (
        globalThis as unknown as {
          window: { location: { pathname: string } };
        }
      ).window.location.pathname;
    function Harness() {
      current = useRunBundleLoader(deps);
      return createElement("div");
    }
    const restoreBrowser = installFakeBrowser();
    let renderer: ReturnType<typeof create> | null = null;
    let pendingLoad: Promise<LoadedRunBundle | null> | null = null;
    let lastSelection: Promise<LoadedRunBundle | null> | null = null;
    try {
      await act(async () => {
        renderer = createRenderer(createElement(Harness));
        await flushReactWork();
      });
      await act(async () => {
        await read().loadRecentRun(runA);
        await flushReactWork();
      });
      assert.equal(read().activeRunId, runA.runId);
      assert.equal(pathname(), `/run/${runA.runId}`);
      assert.equal(read().loadingState, null);

      await act(async () => {
        pendingLoad = read().loadRecentRun(runB);
        await flushReactWork();
      });
      assert.equal(read().activeRunId, runA.runId);
      assert.equal(read().loadingState, "run");
      assert.equal(loadsB, 1);

      await act(async () => {
        lastSelection = read().loadRecentRun(scenario === "repeat pending B" ? runB : runA);
        await flushReactWork();
      });
      const afterSelection = {
        activeRunId: read().activeRunId,
        bundle: read().bundle,
        pathname: pathname(),
        loadingState: read().loadingState,
        errorMessage: read().errorMessage,
      };
      await act(async () => {
        if (scenario === "stale error") {
          rejectB(new Error("Obsolete B load failed"));
        } else {
          resolveB(bundleB);
        }
        await pendingLoad;
        await lastSelection;
        await flushReactWork();
      });

      const expectedRun = scenario === "repeat pending B" ? runB : runA;
      const expectedBundle = scenario === "repeat pending B" ? bundleB : bundleA;
      assert.equal(read().activeRunId, expectedRun.runId);
      assert.strictEqual(read().bundle, expectedBundle);
      assert.equal(pathname(), `/run/${expectedRun.runId}`);
      assert.equal(read().loadingState, null);
      assert.equal(read().errorMessage, null);
      assert.equal(loadsA, 1, "reselecting displayed A must not refetch A");
      assert.equal(loadsB, 1, "repeating a pending B selection must not duplicate its read");
      assert.equal(afterSelection.activeRunId, runA.runId);
      assert.strictEqual(afterSelection.bundle, bundleA);
      assert.equal(afterSelection.pathname, `/run/${runA.runId}`);
      assert.equal(afterSelection.errorMessage, null);
      assert.equal(afterSelection.loadingState, scenario === "repeat pending B" ? "run" : null);

      if (scenario !== "repeat pending B") {
        await act(async () => {
          await read().loadRecentRun(runB);
          await flushReactWork();
        });
        assert.equal(loadsB, 2, "superseded loading identity must not block a fresh B selection");
        assert.equal(read().activeRunId, runB.runId);
        assert.equal(pathname(), `/run/${runB.runId}`);
        assert.equal(read().loadingState, null);
      }
    } finally {
      await act(async () => {
        resolveB(bundleB);
        await pendingLoad;
        await lastSelection;
        renderer?.unmount();
        await flushReactWork();
      });
      restoreBrowser();
    }
  });
}
