import { loadRunBundle } from "../src/lib/load-bundle.js";
import type { ViewerRunLiveState, ViewerRunsState } from "../src/types.js";
import { createFilesystemBundleReader } from "./filesystem-bundle-reader.js";
import { defaultRunsDir, listRunBundles } from "./run-bundles.js";

export type ViewerRunSource = {
  getRunsState(): Promise<ViewerRunsState>;
  getRunState(runId: string): Promise<ViewerRunLiveState>;
};

export function createFilesystemRunSource(runsDir: string = defaultRunsDir()): ViewerRunSource {
  return {
    async getRunsState(): Promise<ViewerRunsState> {
      return {
        schema: "acpx.viewer-runs.v1",
        runs: await listRunBundles(runsDir),
      };
    },
    async getRunState(runId: string): Promise<ViewerRunLiveState> {
      const bundle = await loadRunBundle(createFilesystemBundleReader(runsDir, { runId }));
      return {
        ...bundle,
        schema: "acpx.viewer-run-live.v1",
      };
    },
  };
}
