import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpxOperationalError } from "../errors.js";
import { acpxHomeDir } from "../session/event-log.js";

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

async function assertDirectoryExists(flag: string, dir: string): Promise<void> {
  const stat = await fs.stat(dir).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw new AcpxOperationalError(
      `${flag} "${dir}" cannot be accessed: ${error instanceof Error ? error.message : String(error)}`,
      { outputCode: "USAGE", detailCode: "ADDITIONAL_DIR_STAT", cause: error },
    );
  });
  if (stat === undefined || !stat.isDirectory()) {
    throw new AcpxOperationalError(
      `${flag} "${dir}" ${stat === undefined ? "does not exist" : "is not a directory"}`,
      { outputCode: "USAGE", detailCode: "ADDITIONAL_DIR_NOT_FOUND" },
    );
  }
}

export type ResolveAdditionalDirectoriesOptions = {
  /** Lenient mode: called per entry that fails instead of throwing (reconnect). */
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
 * Merges raw additionalDirs with skillsDirs resolved into synthetic roots.
 * Strict by default; pass onError for lenient reconnect behavior.
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
    try {
      await assertDirectoryExists("--additional-dir", dir);
      merged.push(dir);
    } catch (error) {
      if (!options.onError) {
        throw error;
      }
      options.onError(error);
    }
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

/**
 * Harnesses disagree on where skills live inside a workspace root:
 * Claude-style scanners read `<root>/.claude/skills/`, the cross-client
 * convention reads `<root>/.agents/skills/`. A `--skills-dir` points at a
 * directory that directly contains skill folders, so acpx materializes a
 * synthetic root per dir that exposes it under both layouts, then sends the
 * synthetic root as an ACP `additionalDirectories` entry.
 *
 * Roots are content-addressed by the resolved skills dir so repeated sessions
 * reuse the same root. The link targets are the ownership record: a root
 * whose links point at a different dir is a hash collision and fails loudly.
 */
async function buildSkillsDirRoot(resolved: string): Promise<string> {
  await assertDirectoryExists("--skills-dir", resolved);
  const root = path.join(
    skillsRootsBase(),
    createHash("sha256").update(resolved).digest("hex").slice(0, 16),
  );
  try {
    await linkSkillsDir(root, ".claude", resolved);
    await linkSkillsDir(root, ".agents", resolved);
  } catch (error) {
    if (error instanceof AcpxOperationalError) {
      throw error;
    }
    throw new AcpxOperationalError(
      `Failed to materialize skills root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      { outputCode: "RUNTIME", origin: "acp", detailCode: "SKILLS_ROOT_IO", cause: error },
    );
  }
  return root;
}

function skillsRootsBase(): string {
  return path.join(acpxHomeDir(), "skills-roots");
}

/**
 * Links `<root>/<layout>/skills` → target. An existing link to the same
 * target is reused; a link to a different live target means a hash collision
 * and fails; a dangling link is replaced. "junction" works on Windows without
 * elevation and is ignored on POSIX.
 */
async function linkSkillsDir(root: string, layout: string, target: string): Promise<void> {
  const link = path.join(root, layout, "skills");
  const resolvedTarget = await fs.realpath(target).catch(() => target);
  await fs.mkdir(path.dirname(link), { recursive: true, mode: 0o700 });

  const existing = await fs.lstat(link).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    const current = await fs.realpath(link).catch(() => undefined);
    if (current === resolvedTarget) {
      return;
    }
    if (current !== undefined) {
      throw skillsRootConflictError(root, current, resolvedTarget);
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
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await resolveLinkRace(root, link, resolvedTarget);
  }
}

function skillsRootConflictError(
  root: string,
  owner: string,
  target: string,
): AcpxOperationalError {
  return new AcpxOperationalError(
    `Skills root ${root} is owned by "${owner}", not "${target}" (hash collision)`,
    { outputCode: "RUNTIME", origin: "acp", detailCode: "SKILLS_ROOT_CONFLICT" },
  );
}

/**
 * A concurrent acpx process created the link between lstat and symlink.
 * Accept it when the winner points at our target; replace a dangling winner
 * once; a live winner pointing elsewhere is a hash collision.
 */
async function resolveLinkRace(root: string, link: string, target: string): Promise<void> {
  const winner = await fs.realpath(link).catch(() => undefined);
  if (winner === target) {
    return;
  }
  if (winner === undefined) {
    await fs.rm(link, { force: true });
    await fs.symlink(target, link, "junction");
    return;
  }
  throw skillsRootConflictError(root, winner, target);
}

/**
 * Removes synthetic roots that are stale: every skills link dangles (target
 * deleted), or the root has no links and is old enough that a live creator
 * cannot still be working. Best-effort: failures are swallowed.
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
  const links = [path.join(root, ".claude", "skills"), path.join(root, ".agents", "skills")];
  const stats = await Promise.all(links.map((link) => fs.lstat(link).catch(() => undefined)));
  if (stats.every((stat) => stat?.isSymbolicLink())) {
    const targets = await Promise.all(
      links.map((link) => fs.realpath(link).catch(() => undefined)),
    );
    if (targets.every((target) => target === undefined)) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  if (stats.every((stat) => stat === undefined)) {
    const rootStat = await fs.stat(root).catch(() => undefined);
    if (rootStat !== undefined && Date.now() - rootStat.mtimeMs > 60_000) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}
