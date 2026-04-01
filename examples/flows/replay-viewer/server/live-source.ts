import { loadRunBundle } from "../src/lib/load-bundle.js";
import { buildViewerRunsState } from "../src/lib/runs-state.js";
import type { ViewerRunLiveState, ViewerRunsState } from "../src/types.js";
import { createFilesystemBundleReader } from "./filesystem-bundle-reader.js";
import { synthesizeLiveRunState } from "./live-run-state.js";
import { defaultRunsDir, listRunBundles } from "./run-bundles.js";

export type ViewerRunSource = {
  getRunsState(): Promise<ViewerRunsState>;
  getRunState(runId: string): Promise<ViewerRunLiveState>;
};

export function createFilesystemRunSource(runsDir: string = defaultRunsDir()): ViewerRunSource {
  return {
    async getRunsState(): Promise<ViewerRunsState> {
      return buildViewerRunsState(await listRunBundles(runsDir));
    },
    async getRunState(runId: string): Promise<ViewerRunLiveState> {
      const bundle = await loadRunBundle(createFilesystemBundleReader(runsDir, { runId }));
      return synthesizeLiveRunState({
        ...bundle,
        schema: "acpx.viewer-run-live.v1",
      });
    },
  };
}
