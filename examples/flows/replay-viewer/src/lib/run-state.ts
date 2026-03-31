import type { FlowRunState } from "../types.js";

export function mergeLiveRunState(
  run: FlowRunState,
  live: Partial<FlowRunState> | null,
): FlowRunState {
  if (!live) {
    return run;
  }

  return {
    ...run,
    ...live,
    input: live.input ?? run.input,
    outputs: live.outputs ?? run.outputs,
    results: live.results ?? run.results,
    steps: live.steps ?? run.steps,
    sessionBindings: live.sessionBindings ?? run.sessionBindings,
  };
}
