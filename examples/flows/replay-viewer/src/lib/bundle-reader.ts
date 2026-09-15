import type { RunBundleSummary } from "../types.js";

export type BundleReader = {
  sourceType: "sample" | "local" | "recent";
  label: string;
  readText(relativePath: string): Promise<string>;
};

type RunsIndexResponse = {
  runs: RunBundleSummary[];
};

export function createRecentRunBundleReader(run: RunBundleSummary): BundleReader {
  const basePath = `/api/runs/${encodeURIComponent(run.runId)}/files`;

  async function readText(relativePath: string): Promise<string> {
    const response = await fetch(
      `${basePath}/${relativePath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to read ${relativePath}: ${response.status}`);
    }
    return response.text();
  }

  return {
    sourceType: "recent",
    label: `Recent run: ${run.runId}`,
    readText,
  };
}

export async function listRecentRuns(): Promise<RunBundleSummary[] | null> {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as RunsIndexResponse;
    return payload.runs;
  } catch {
    return null;
  }
}
