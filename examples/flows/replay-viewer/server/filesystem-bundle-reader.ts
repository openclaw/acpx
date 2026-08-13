import type { BundleReader } from "../src/lib/bundle-reader.js";
import type { RunBundleSummary } from "../src/types.js";
import {
  readRunBundleFile as readContainedRunBundleFile,
  readRunBundleTextFile,
} from "./run-bundles.js";

export function createFilesystemBundleReader(
  runsDir: string,
  run: Pick<RunBundleSummary, "runId">,
): BundleReader {
  async function readText(relativePath: string): Promise<string> {
    return await readRunBundleTextFile(runsDir, run.runId, relativePath);
  }

  return {
    sourceType: "recent",
    label: `Recent run: ${run.runId}`,
    readText,
    async readJson<T>(relativePath: string): Promise<T> {
      const text = await readText(relativePath);
      return JSON.parse(text) as T;
    },
  };
}

export async function readBundleFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<Buffer> {
  return await readContainedRunBundleFile(runsDir, runId, relativePath);
}
