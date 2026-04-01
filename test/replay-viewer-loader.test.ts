import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import {
  useRunBundleLoader,
  type RunBundleLoaderDeps,
} from "../examples/flows/replay-viewer/src/hooks/use-run-bundle-loader.js";
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
