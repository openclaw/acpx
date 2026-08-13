import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
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

export async function resolveRunBundleFilePath(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<string> {
  return (await resolveRunBundleFileTarget(runsDir, runId, relativePath)).realPath;
}

async function resolveRunBundleFileTarget(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<{ realPath: string; realRunDir: string }> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const resolvedRunsDir = path.resolve(runsDir);
  const runDir = path.resolve(resolvedRunsDir, runId);
  if (!isPathInsideDirectory(resolvedRunsDir, runDir, { allowSamePath: false })) {
    throw new Error(`Refusing to read run bundle outside runs directory: ${runId}`);
  }
  const resolvedPath = path.resolve(runDir, normalizedRelativePath);

  if (!isPathInsideDirectory(runDir, resolvedPath)) {
    throw new Error(`Refusing to read outside run bundle: ${relativePath}`);
  }

  const [realRunsDir, realRunDir, realPath] = await Promise.all([
    fs.realpath(resolvedRunsDir),
    fs.realpath(runDir),
    fs.realpath(resolvedPath),
  ]);
  if (!isPathInsideDirectory(realRunsDir, realRunDir, { allowSamePath: false })) {
    throw new Error(`Refusing to read run bundle outside runs directory: ${runId}`);
  }
  if (!isPathInsideDirectory(realRunDir, realPath)) {
    throw new Error(`Refusing to read outside run bundle: ${relativePath}`);
  }

  return { realPath, realRunDir };
}

export async function readRunBundleTextFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<string> {
  const file = await openContainedRunBundleFile(runsDir, runId, relativePath);
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function readRunBundleFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<Buffer> {
  const file = await openContainedRunBundleFile(runsDir, runId, relativePath);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function openContainedRunBundleFile(
  runsDir: string,
  runId: string,
  relativePath: string,
): Promise<FileHandle> {
  const { realPath: checkedPath, realRunDir } = await resolveRunBundleFileTarget(
    runsDir,
    runId,
    relativePath,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const file = await fs.open(checkedPath, fsConstants.O_RDONLY | noFollow);
  try {
    const [openedStat, currentPath] = await Promise.all([
      file.stat(),
      fs.realpath(path.resolve(runsDir, runId, normalizeRelativePath(relativePath))),
    ]);
    if (!isPathInsideDirectory(realRunDir, currentPath)) {
      throw new Error(`Refusing to read outside run bundle: ${relativePath}`);
    }
    const currentStat = await fs.stat(currentPath);
    if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
      throw new Error(`Refusing changed run bundle path: ${relativePath}`);
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readRunBundleSummary(runsDir: string, runId: string): Promise<RunBundleSummary> {
  const runDir = path.join(runsDir, runId);
  const manifest = JSON.parse(
    await readRunBundleTextFile(runsDir, runId, "manifest.json"),
  ) as FlowRunManifest;
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

function isPathInsideDirectory(
  rootDir: string,
  candidatePath: string,
  options: { allowSamePath?: boolean } = {},
): boolean {
  const relativePath = path.relative(rootDir, candidatePath);
  if (!options.allowSamePath && relativePath.length === 0) {
    return false;
  }
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}
