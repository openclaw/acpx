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
  RunBundleSummary,
} from "../examples/flows/replay-viewer/src/types.js";

Object.assign(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }, {
  IS_REACT_ACT_ENVIRONMENT: true,
});

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
    renderer = create(createElement(Harness));
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
      renderer = create(createElement(Harness));
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
    renderer = create(createElement(Harness));
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
    renderer = create(createElement(Harness));
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
      renderer = create(createElement(Harness));
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
      renderer = create(createElement(Harness));
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
      renderer = create(createElement(Harness));
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
