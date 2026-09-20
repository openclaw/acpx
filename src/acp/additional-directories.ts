import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpxOperationalError } from "../errors.js";

export class AdditionalDirectoriesUnsupportedError extends AcpxOperationalError {
  constructor(agentCommand: string | undefined) {
    super(
      `Agent ${agentCommand ? `"${agentCommand}"` : "command"} does not advertise ` +
        `sessionCapabilities.additionalDirectories; --skills-dir and --additional-dir ` +
        `cannot be applied.`,
      {
        outputCode: "USAGE",
        origin: "acp",
        detailCode: "ADDITIONAL_DIRECTORIES_UNSUPPORTED",
      },
    );
  }
}

const SKILLS_ROOT_MARKER = ".acpx-skills-root";

async function assertDirectoryExists(flag: string, dir: string): Promise<void> {
  const stat = await fs.stat(dir).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw new AcpxOperationalError(
      `${flag} "${dir}" cannot be accessed: ${error instanceof Error ? error.message : String(error)}`,
      {
        outputCode: "USAGE",
        detailCode: "ADDITIONAL_DIR_STAT",
        cause: error instanceof Error ? error : undefined,
      },
    );
  });
  if (stat === undefined) {
    throw new AcpxOperationalError(`${flag} "${dir}" does not exist`, {
      outputCode: "USAGE",
      detailCode: "ADDITIONAL_DIR_NOT_FOUND",
    });
  }
  if (!stat.isDirectory()) {
    throw new AcpxOperationalError(`${flag} "${dir}" is not a directory`, {
      outputCode: "USAGE",
      detailCode: "ADDITIONAL_DIR_NOT_FOUND",
    });
  }
}

export type ResolveAdditionalDirectoriesOptions = {
  /**
   * Lenient mode: called per entry that fails to resolve instead of throwing.
   * Used on reconnect so one stale dir does not strip the rest.
   */
  onError?: (error: unknown) => void;
};

export type ResolvedAdditionalDirectories = {
  /** Roots sent to the agent via ACP additionalDirectories. */
  dirs: string[];
  /**
   * Synthetic skills-root → real skills dir. The fs layer rewrites reads
   * through `<root>/.claude/skills` and `<root>/.agents/skills` onto the
   * target so follow-within-root containment still holds.
   */
  skillTargets: Map<string, string>;
};

/**
 * Merges raw additionalDirs with skillsDirs resolved into synthetic roots
 * (each exposed as `.claude/skills` and `.agents/skills`). Returns undefined
 * when neither is set. Strict by default; pass onError for lenient reconnect
 * behavior.
 */
export async function resolveAdditionalDirectories(
  sessionOptions: { skillsDirs?: string[]; additionalDirs?: string[] } | undefined,
  options: ResolveAdditionalDirectoriesOptions = {},
): Promise<ResolvedAdditionalDirectories | undefined> {
  const dirs = await collectRawDirs(sessionOptions?.additionalDirs, options);
  const skillTargets = await collectSkillsRoots(sessionOptions?.skillsDirs, options);
  dirs.push(...skillTargets.keys());
  return dirs.length > 0 ? { dirs, skillTargets } : undefined;
}

async function collectRawDirs(
  dirs: readonly string[] | undefined,
  options: ResolveAdditionalDirectoriesOptions,
): Promise<string[]> {
  const merged: string[] = [];
  for (const dir of new Set(
    dirs?.filter((entry) => entry.length > 0).map((entry) => path.resolve(entry)) ?? [],
  )) {
    await collectEntry(merged, options, async () => {
      await assertDirectoryExists("--additional-dir", dir);
      return dir;
    });
  }
  return merged;
}

async function collectSkillsRoots(
  dirs: readonly string[] | undefined,
  options: ResolveAdditionalDirectoriesOptions,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const resolved = await Promise.all(
    [
      ...new Set(
        dirs?.filter((entry) => entry.length > 0).map((entry) => path.resolve(entry)) ?? [],
      ),
    ].map(async (dir) => await fs.realpath(dir).catch(() => dir)),
  );
  for (const dir of new Set(resolved)) {
    try {
      roots.set(await buildSkillsDirRoot(dir), dir);
    } catch (error) {
      if (!options.onError) {
        throw error;
      }
      options.onError(error);
    }
  }
  if (roots.size > 0) {
    void sweepStaleSkillsRoots().catch(() => {});
  }
  return roots;
}

async function collectEntry(
  merged: string[],
  options: ResolveAdditionalDirectoriesOptions,
  resolve: () => Promise<string>,
): Promise<void> {
  try {
    merged.push(await resolve());
  } catch (error) {
    if (!options.onError) {
      throw error;
    }
    options.onError(error);
  }
}

function skillsRootsBase(): string {
  return path.join(os.homedir(), ".acpx", "skills-roots");
}

/**
 * Harnesses disagree on where skills live inside a workspace root:
 * Claude-style scanners read `<root>/.claude/skills/`, the cross-client
 * convention reads `<root>/.agents/skills/`. A `--skills-dir` points at a
 * directory that directly contains skill folders, so acpx materializes a
 * synthetic root per dir that exposes it under both layouts, then sends the
 * synthetic root as an ACP `additionalDirectories` entry.
 *
 * Roots are content-addressed by the resolved skills dir so repeated sessions
 * reuse the same root. Symlinks are "junction"-typed so they work on Windows
 * without elevated privileges; the type is ignored on POSIX.
 */
async function buildSkillsDirRoot(resolved: string): Promise<string> {
  await assertDirectoryExists("--skills-dir", resolved);

  const root = path.join(
    skillsRootsBase(),
    createHash("sha256").update(resolved).digest("hex").slice(0, 16),
  );
  try {
    await assertSkillsRootOwner(root, resolved);
    await linkSkillsDir(root, ".claude", resolved);
    await linkSkillsDir(root, ".agents", resolved);
  } catch (error) {
    if (error instanceof AcpxOperationalError) {
      throw error;
    }
    throw new AcpxOperationalError(
      `Failed to materialize skills root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      {
        outputCode: "RUNTIME",
        origin: "acp",
        detailCode: "SKILLS_ROOT_IO",
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
  return root;
}

/**
 * The root name is a truncated hash of the resolved path; a marker file pins
 * the owning path so a hash collision between two different skills dirs fails
 * loudly instead of silently flip-flopping the links. The marker is created
 * with `wx` so concurrent first-creators cannot both win.
 */
async function assertSkillsRootOwner(root: string, resolved: string): Promise<void> {
  const marker = path.join(root, SKILLS_ROOT_MARKER);
  const existing = await fs.readFile(marker, "utf8").catch(() => undefined);
  if (existing !== undefined) {
    if (existing.length > 0 && (existing === resolved || (await directoryExists(existing)))) {
      assertSkillsRootOwnerMatch(root, existing, resolved);
      return;
    }
    // Empty (torn write) or dead-owner marker — stale; reclaim it.
    await reclaimSkillsRootMarker(root, marker, resolved);
    return;
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(marker, resolved, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await resolveSkillsRootOwnerRace(root, marker, resolved);
  }
}

function assertSkillsRootOwnerMatch(root: string, owner: string, resolved: string): void {
  if (owner !== resolved) {
    throw new AcpxOperationalError(
      `Skills root ${root} is owned by "${owner}", not "${resolved}" (hash collision)`,
      { outputCode: "RUNTIME", origin: "acp", detailCode: "SKILLS_ROOT_CONFLICT" },
    );
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  return await fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/**
 * Removes a stale marker and rewrites it with `wx`. If another process claims
 * the marker in the rm→write gap, accept it only when it agrees with us; an
 * in-flight (empty) winner triggers one retry, then we defer to it.
 */
async function reclaimSkillsRootMarker(
  root: string,
  marker: string,
  resolved: string,
  retried = false,
): Promise<void> {
  // Re-read before removing: a winner may have completed its write since the
  // caller observed the stale marker.
  const current = await fs.readFile(marker, "utf8").catch(() => "");
  if (current === resolved) {
    return;
  }
  if (current.length > 0 && (await directoryExists(current))) {
    assertSkillsRootOwnerMatch(root, current, resolved);
    return;
  }
  await fs.rm(marker, { force: true });
  try {
    await fs.writeFile(marker, resolved, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await resolveReclaimedMarkerRace(root, marker, resolved, retried);
  }
}

/**
 * Another process claimed the marker in the rm→write gap. Accept it when it
 * agrees with us; an in-flight (empty) winner triggers one retry, then we
 * defer to it.
 */
async function resolveReclaimedMarkerRace(
  root: string,
  marker: string,
  resolved: string,
  retried: boolean,
): Promise<void> {
  const third = await fs.readFile(marker, "utf8").catch(() => "");
  if (third.length === 0) {
    if (!retried) {
      await reclaimSkillsRootMarker(root, marker, resolved, true);
    }
    return;
  }
  if (third !== resolved && !(await directoryExists(third))) {
    // Winner's marker names a deleted dir — stale; reclaim once (bounded by
    // the same retried flag).
    if (!retried) {
      await reclaimSkillsRootMarker(root, marker, resolved, true);
    }
    return;
  }
  assertSkillsRootOwnerMatch(root, third, resolved);
}

/**
 * Another process won the marker create; its marker must agree with us. An
 * empty marker means the winner crashed mid-write — reclaim it once. A marker
 * whose recorded owner dir no longer exists is stale — reclaim it too.
 */
async function resolveSkillsRootOwnerRace(
  root: string,
  marker: string,
  resolved: string,
): Promise<void> {
  const winner = await fs.readFile(marker, "utf8").catch(() => "");
  if (winner === resolved) {
    return;
  }
  if (winner.length === 0 || !(await directoryExists(winner))) {
    await reclaimSkillsRootMarker(root, marker, resolved);
    return;
  }
  assertSkillsRootOwnerMatch(root, winner, resolved);
}

/**
 * Removes synthetic roots that are stale: every skills link dangles (target
 * deleted), or the marker's recorded owner dir no longer exists (crash between
 * marker write and link creation, or the skills dir was deleted). Roots with a
 * missing link and a live owner are skipped — they may be mid-creation by a
 * concurrent process. Best-effort: a concurrent re-link can still race the
 * final fs.rm, which is why failures are swallowed.
 */
async function sweepStaleSkillsRoots(): Promise<void> {
  const base = skillsRootsBase();
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await sweepSkillsRoot(path.join(base, entry.name));
    }
  }
}

async function sweepSkillsRoot(root: string): Promise<void> {
  const owner = await fs.readFile(path.join(root, SKILLS_ROOT_MARKER), "utf8").catch(() => "");
  if (owner.length > 0 && !(await directoryExists(owner))) {
    // Re-read before removing: a concurrent reclaim may have rewritten the
    // marker since we read it.
    const latest = await fs.readFile(path.join(root, SKILLS_ROOT_MARKER), "utf8").catch(() => "");
    if (latest === owner) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  const links = [path.join(root, ".claude", "skills"), path.join(root, ".agents", "skills")];
  const stats = await Promise.all(links.map((link) => fs.lstat(link).catch(() => undefined)));
  if (!stats.every((stat) => stat?.isSymbolicLink())) {
    await sweepAbandonedRoot(root, owner, stats);
    return;
  }
  const targets = await Promise.all(links.map((link) => fs.realpath(link).catch(() => undefined)));
  if (targets.every((target) => target === undefined)) {
    await removeDanglingSkillsRoot(root, owner);
  }
}

/**
 * Removes a root whose links all dangle. Re-reads the marker first: absent
 * means a reclaim's rm→write gap (skip); unchanged-still-stale or a
 * confirmed-dead owner → remove.
 */
async function removeDanglingSkillsRoot(root: string, owner: string): Promise<void> {
  const latest = await fs
    .readFile(path.join(root, SKILLS_ROOT_MARKER), "utf8")
    .catch(() => undefined);
  if (latest === owner || (latest !== undefined && !(await directoryExists(latest)))) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function linkSkillsDir(root: string, layout: string, target: string): Promise<void> {
  const parent = path.join(root, layout);
  const link = path.join(parent, "skills");
  const resolvedTarget = await fs.realpath(target).catch(() => target);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });

  const existing = await fs.lstat(link).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    const current = await fs.realpath(link).catch(() => undefined);
    if (current === resolvedTarget) {
      return;
    }
    await fs.rm(link, { force: true });
  } else if (existing) {
    throw new AcpxOperationalError(`Cannot link skills dir: ${link} exists and is not a symlink`, {
      outputCode: "RUNTIME",
      origin: "acp",
      detailCode: "SKILLS_ROOT_CONFLICT",
    });
  }

  try {
    await fs.symlink(resolvedTarget, link, "junction");
  } catch (error) {
    // A concurrent acpx process may have created the same link between the
    // lstat and the symlink; accept it when the winner points at our target.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = await fs.realpath(link).catch(() => undefined);
      if (winner === resolvedTarget) {
        return;
      }
      // Winner's link dangles or points elsewhere — remove and retry once.
      await fs.rm(link, { force: true });
      await fs.symlink(resolvedTarget, link, "junction");
      return;
    }
    throw error;
  }
}

/**
 * A root with no marker and no links was abandoned mid-creation. Only sweep it
 * once it is old enough that a live creator cannot still be working.
 */
async function sweepAbandonedRoot(
  root: string,
  owner: string,
  stats: (Stats | undefined)[],
): Promise<void> {
  if (owner.length > 0 || !stats.every((stat) => stat === undefined)) {
    return;
  }
  const rootStat = await fs.stat(root).catch(() => undefined);
  if (rootStat !== undefined && Date.now() - rootStat.mtimeMs > 60_000) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
