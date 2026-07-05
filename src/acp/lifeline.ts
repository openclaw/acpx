import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAcpxVersion } from "../version.js";

const execFileAsync = promisify(execFile);
const LIFELINE_HELPER_ENV = "ACPX_LIFELINE_HELPER";
const failedCompileCachePaths = new Set<string>();
const reportedCompileFailures = new Set<string>();
let cachedPackageRoot: string | undefined;

type EnsureLifelineHelperOptions = {
  arch?: string;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
};

type LifelineTarget = {
  arch: string;
  cachePath: string;
  platform: NodeJS.Platform;
};

type FastPathResult =
  | {
      helper?: string;
      status: "done";
    }
  | {
      status: "compile";
    };

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveEnvOverride(override: string): string | undefined {
  if (!path.isAbsolute(override)) {
    return undefined;
  }
  return isExecutableFile(override) ? override : undefined;
}

function configuredEnvOverride(): string | undefined {
  return process.env[LIFELINE_HELPER_ENV]?.trim() || undefined;
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function lifelineHelperName(platform: NodeJS.Platform, arch: string): string {
  return `lifeline-${platform}-${arch}`;
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findPackageRoot(): string | undefined {
  if (cachedPackageRoot !== undefined) {
    return cachedPackageRoot;
  }

  let current = moduleDir();
  while (true) {
    if (isAcpxPackageRoot(current)) {
      cachedPackageRoot = current;
      return cachedPackageRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isAcpxPackageRoot(candidate: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return parsed.name === "acpx";
  } catch {
    return false;
  }
}

function prebuiltCandidates(fileName: string): string[] {
  const base = moduleDir();
  const packageRoot = findPackageRoot();
  return unique([
    path.join(base, "native", fileName),
    ...(packageRoot ? [path.join(packageRoot, "dist", "native", fileName)] : []),
  ]);
}

function sourceCandidates(fileName: string): string[] {
  const packageRoot = findPackageRoot();
  return packageRoot ? [path.join(packageRoot, "native", fileName)] : [];
}

function findExecutable(candidates: string[]): string | undefined {
  return candidates.find(isExecutableFile);
}

function findExistingFile(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function cachePathFor(platform: NodeJS.Platform, arch: string): string {
  return path.join(
    os.homedir(),
    ".acpx",
    "native",
    `lifeline-${getAcpxVersion()}-${platform}-${arch}`,
  );
}

function resolveCachedHelper(platform: NodeJS.Platform, arch: string): string | undefined {
  const cachePath = cachePathFor(platform, arch);
  return isExecutableFile(cachePath) ? cachePath : undefined;
}

export function resolveLifelineHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const override = configuredEnvOverride();
  if (override) {
    return resolveEnvOverride(override);
  }

  if (!isSupportedPlatform(platform)) {
    return undefined;
  }

  return (
    findExecutable(prebuiltCandidates(lifelineHelperName(platform, arch))) ??
    resolveCachedHelper(platform, arch)
  );
}

export async function ensureLifelineHelper(
  options: EnsureLifelineHelperOptions = {},
): Promise<string | undefined> {
  const target = lifelineTarget(options);
  const fastPath = resolveEnsureFastPath(target);
  if (fastPath.status === "done") {
    return fastPath.helper;
  }
  if (hasRememberedCompileFailure(target.cachePath)) {
    return undefined;
  }

  const source = findExistingFile(sourceCandidates("lifeline.c"));
  if (!source) {
    await rememberCompileFailure(target.cachePath, "lifeline source not found", options.log);
    return undefined;
  }

  try {
    await compileLifelineSource(source, target.cachePath);
    return isExecutableFile(target.cachePath) ? target.cachePath : undefined;
  } catch (error) {
    await rememberCompileFailure(target.cachePath, formatCompileFailure(error), options.log);
    return undefined;
  }
}

function lifelineTarget(options: EnsureLifelineHelperOptions): LifelineTarget {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return {
    arch,
    cachePath: cachePathFor(platform, arch),
    platform,
  };
}

function resolveEnsureFastPath(target: LifelineTarget): FastPathResult {
  const resolved = resolveLifelineHelper(target.platform, target.arch);
  if (resolved || configuredEnvOverride() || !isSupportedPlatform(target.platform)) {
    return {
      helper: resolved,
      status: "done",
    };
  }
  return { status: "compile" };
}

function hasRememberedCompileFailure(cachePath: string): boolean {
  return failedCompileCachePaths.has(cachePath) || fs.existsSync(`${cachePath}.failed`);
}

async function compileLifelineSource(source: string, cachePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await execFileAsync(process.env.CC ?? "cc", ["-O2", "-o", tmpPath, source]);
    await renameCompiledHelper(tmpPath, cachePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function renameCompiledHelper(tmpPath: string, cachePath: string): Promise<void> {
  try {
    await fsp.rename(tmpPath, cachePath);
  } catch (error) {
    if (fs.existsSync(cachePath)) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      return;
    }
    throw error;
  }
}

async function rememberCompileFailure(
  cachePath: string,
  reason: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  failedCompileCachePaths.add(cachePath);
  await fsp.mkdir(path.dirname(cachePath), { recursive: true }).catch(() => {});
  await fsp.writeFile(`${cachePath}.failed`, `${reason}\n`, "utf8").catch(() => {});
  if (reportedCompileFailures.has(cachePath)) {
    return;
  }
  reportedCompileFailures.add(cachePath);
  log?.(`lifeline helper lazy compile failed: ${reason}`);
}

function formatCompileFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
