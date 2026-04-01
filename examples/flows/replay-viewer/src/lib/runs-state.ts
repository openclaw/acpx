import type { RunBundleSummary, ViewerRunsState } from "../types.js";

export function buildViewerRunsState(runs: RunBundleSummary[]): ViewerRunsState {
  return {
    schema: "acpx.viewer-runs.v2",
    order: runs.map((run) => run.runId),
    runsById: Object.fromEntries(runs.map((run) => [run.runId, run])),
  };
}

export function listViewerRuns(state: ViewerRunsState): RunBundleSummary[] {
  return state.order.flatMap((runId) => {
    const run = state.runsById[runId];
    return run ? [run] : [];
  });
}
