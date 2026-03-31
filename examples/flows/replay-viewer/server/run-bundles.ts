import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeLiveRunState } from "../src/lib/run-state.js";
import type { FlowRunManifest, FlowRunState, RunBundleSummary } from "../src/types.js";

const DEFAULT_MAX_RUNS = 24;

export function defaultRunsDir(): string {
  return process.env.ACPX_FLOW_RUNS_DIR ?? path.join(os.homedir(), ".acpx", "flows", "runs");
}

export async function listRunBundles(
  runsDir: string = defaultRunsDir(),
  maxRuns: number = DEFAULT_MAX_RUNS,
): Promise<RunBundleSummary[]> {
  const entries = await fs
    .readdir(runsDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });

  const candidateIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .toReversed()
    .slice(0, maxRuns);

  const runs = await Promise.all(
    candidateIds.map(async (runId) => readRunBundleSummary(runsDir, runId).catch(() => null)),
  );

  return runs
    .filter((run): run is RunBundleSummary => run != null)
    .toSorted((left, right) => {
      const byStartedAt = Date.parse(right.startedAt) - Date.parse(left.startedAt);
      if (byStartedAt !== 0) {
        return byStartedAt;
      }
      return right.runId.localeCompare(left.runId);
    });
}

export function resolveRunBundleFilePath(
  runsDir: string,
  runId: string,
  relativePath: string,
): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const runDir = path.resolve(runsDir, runId);
  const resolvedPath = path.resolve(runDir, normalizedRelativePath);

  if (!resolvedPath.startsWith(`${runDir}${path.sep}`) && resolvedPath !== runDir) {
    throw new Error(`Refusing to read outside run bundle: ${relativePath}`);
  }

  return resolvedPath;
}

async function readRunBundleSummary(runsDir: string, runId: string): Promise<RunBundleSummary> {
  const runDir = path.join(runsDir, runId);
  const manifest = JSON.parse(
    await fs.readFile(path.join(runDir, "manifest.json"), "utf8"),
  ) as FlowRunManifest;
  const run = JSON.parse(
    await fs.readFile(path.join(runDir, manifest.paths.runProjection), "utf8"),
  ) as FlowRunState;
  const live = await fs
    .readFile(path.join(runDir, manifest.paths.liveProjection), "utf8")
    .then((text) => JSON.parse(text) as Partial<FlowRunState>)
    .catch(() => null);
  const mergedRun = mergeLiveRunState(run, live);

  return {
    runId: manifest.runId,
    flowName: manifest.flowName,
    runTitle: manifest.runTitle ?? mergedRun.runTitle,
    status: mergedRun.status,
    startedAt: manifest.startedAt,
    finishedAt: mergedRun.finishedAt ?? manifest.finishedAt,
    updatedAt: mergedRun.updatedAt,
    currentNode: mergedRun.currentNode,
    path: runDir,
  };
}

function normalizeRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) {
    throw new Error("Bundle path is required");
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error("Absolute bundle paths are not allowed");
  }
  const normalized = path.normalize(trimmed);
  if (normalized.startsWith(`..${path.sep}`) || normalized === "..") {
    throw new Error("Parent directory traversal is not allowed");
  }
  return normalized;
}
