import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe";
import { hasNodeErrorCode, isPathInside } from "@openclaw/fs-safe/path";
import { root, type Root } from "@openclaw/fs-safe/root";
import { mergeLiveRunState } from "../src/lib/run-state.js";
import type { FlowRunManifest, FlowRunState, RunBundleSummary } from "../src/types.js";

const DEFAULT_MAX_RUNS = 24;

export class RunBundleNotFoundError extends Error {
  constructor(cause: unknown) {
    super("Run bundle not found", { cause });
    this.name = "RunBundleNotFoundError";
  }
}

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
    .toReversed();

  const limit = candidateIds.slice(0, maxRuns).length;
  const runs: RunBundleSummary[] = [];
  for (let offset = 0; offset < candidateIds.length && runs.length < limit;) {
    const batchIds = candidateIds.slice(
      offset,
      offset + Math.min(DEFAULT_MAX_RUNS, limit - runs.length),
    );
    offset += batchIds.length;
    const batch = await Promise.all(
      batchIds.map((runId) => readRunBundleSummary(runsDir, runId).catch(() => null)),
    );
    runs.push(...batch.filter((run): run is RunBundleSummary => run != null));
  }

  return runs.toSorted((left, right) => {
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
  const runs = await openRunsRoot(resolvedRunsDir);
  const bundle = await openBundleRoot(
    runs,
    `.${path.sep}${path.relative(resolvedRunsDir, runDir)}`,
  );
  if (bundle.rootReal === runs.rootReal || !isPathInside(runs.rootReal, bundle.rootReal)) {
    throw new Error(`Refusing to read run bundle outside runs directory: ${runId}`);
  }
  const relativeFilePath = `.${path.sep}${normalizedRelativePath}`;
  try {
    return await bundle.readBytes(relativeFilePath);
  } catch (error) {
    // A dangling denied file alias must not become a recoverable missing-file error.
    await bundle.stat(relativeFilePath);
    throw error;
  }
}

async function openRunsRoot(runsDir: string): Promise<Root> {
  try {
    return await root(runsDir);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      throw new RunBundleNotFoundError(error);
    }
    throw error;
  }
}

async function openBundleRoot(runs: Root, relativeRunPath: string): Promise<Root> {
  const resolvedRunPath = await runs.resolve(relativeRunPath);
  try {
    return await root(resolvedRunPath, {
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: Infinity,
    });
  } catch (error) {
    // A failed final-symlink target must pass strict containment before absence is trusted.
    await confirmMissingBundleRoot(runs, relativeRunPath);
    throw error;
  }
}

async function confirmMissingBundleRoot(runs: Root, relativeRunPath: string): Promise<void> {
  try {
    await runs.stat(relativeRunPath);
  } catch (error) {
    if (
      error instanceof FsSafeError &&
      error.code === "not-found" &&
      (hasNodeErrorCode(error.cause, "ENOENT") || hasNodeErrorCode(error.cause, "ENOTDIR"))
    ) {
      throw new RunBundleNotFoundError(error);
    }
    throw error;
  }
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
