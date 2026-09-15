import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { root } from "@openclaw/fs-safe/root";
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

export async function readRunBundleTextFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<string> {
  return (await readRunBundleFile(runsDir, runId, relativePath)).toString("utf8");
}

export async function readRunBundleFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<Buffer> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const resolvedRunsDir = path.resolve(runsDir);
  const runDir = path.resolve(resolvedRunsDir, runId);
  if (runDir === resolvedRunsDir || !isPathInside(resolvedRunsDir, runDir)) {
    throw new Error(`Refusing to read run bundle outside runs directory: ${runId}`);
  }
  const runs = await root(resolvedRunsDir);
  const bundle = await root(
    await runs.resolve(`.${path.sep}${path.relative(resolvedRunsDir, runDir)}`),
    {
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: Infinity,
    },
  );
  if (bundle.rootReal === runs.rootReal || !isPathInside(runs.rootReal, bundle.rootReal)) {
    throw new Error(`Refusing to read run bundle outside runs directory: ${runId}`);
  }
  return await bundle.readBytes(`.${path.sep}${normalizedRelativePath}`);
}

async function readRunBundleSummary(runsDir: string, runId: string): Promise<RunBundleSummary> {
  const runDir = path.join(runsDir, runId);
  const manifest = JSON.parse(
    await readRunBundleTextFile(runsDir, runId, "manifest.json"),
  ) as FlowRunManifest;
  if (typeof manifest.runId !== "string" || typeof manifest.startedAt !== "string") {
    throw new Error("Invalid run bundle identity or start time");
  }
  // The manifest is bundle-controlled data, so its projection paths are
  // constrained to the run bundle before being read. Otherwise a crafted
  // manifest could point runProjection/liveProjection at an arbitrary file
  // outside the bundle (e.g. "../../../etc/passwd") during listRunBundles.
  const run = JSON.parse(
    await readRunBundleTextFile(runsDir, runId, manifest.paths.runProjection),
  ) as FlowRunState;
  const live = await readRunBundleTextFile(runsDir, runId, manifest.paths.liveProjection)
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
