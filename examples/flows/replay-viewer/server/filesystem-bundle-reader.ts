import type { BundleReader } from "../src/lib/bundle-reader.js";
import type { RunBundleSummary } from "../src/types.js";
import { readRunBundleTextFile } from "./run-bundles.js";

export function createFilesystemBundleReader(
  runsDir: string,
  run: Pick<RunBundleSummary, "runId">,
): BundleReader {
  return {
    sourceType: "recent",
    label: `Recent run: ${run.runId}`,
    readText: (relativePath) => readRunBundleTextFile(runsDir, run.runId, relativePath),
  };
}
