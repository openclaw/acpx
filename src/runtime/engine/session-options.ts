import path from "node:path";
import type { SessionRecord } from "../../types.js";

export type SystemPromptOption = string | { append: string };

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
  /**
   * Per-agent environment variables injected into the spawned agent child
   * process and persisted with the session record for reconnects. Keys here
   * override the parent process environment for the spawned child, except
   * acpx-managed auth credential keys. Do not put secrets here; use
   * authCredentials for credentials. Callers are responsible for sanitizing
   * dangerous keys such as `PATH`, `LD_PRELOAD`, and `NODE_OPTIONS` before
   * passing them to acpx.
   */
  env?: Record<string, string>;
  /**
   * Directories containing skill folders (`<dir>/<name>/SKILL.md`). Each is
   * materialized as a synthetic root exposing `.claude/skills` and
   * `.agents/skills`, then sent as `additionalDirectories` on session/new,
   * session/load, and session/resume when the agent advertises the
   * capability. Persisted with the session record so reconnects keep the
   * same roots.
   */
  skillsDirs?: string[];
  /**
   * Raw ACP `additionalDirectories` workspace roots. Unlike skillsDirs these
   * are sent verbatim — no synthetic-root wrapping.
   */
  additionalDirs?: string[];
};

export function mergeSessionOptions(
  preferred: SessionAgentOptions | undefined,
  fallback: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  const merged: SessionAgentOptions = { ...fallback };
  for (const key of [
    "model",
    "allowedTools",
    "maxTurns",
    "systemPrompt",
    "skillsDirs",
    "additionalDirs",
  ] as const) {
    assignDefinedOption(merged, key, preferred?.[key]);
  }
  assignDefinedOption(merged, "env", mergeEnvRecords(fallback?.env, preferred?.env));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeEnvRecords(
  fallback: Record<string, string> | undefined,
  preferred: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!fallback && !preferred) {
    return undefined;
  }
  return { ...fallback, ...preferred };
}

function assignDefinedOption<Key extends keyof SessionAgentOptions>(
  target: SessionAgentOptions,
  key: Key,
  value: SessionAgentOptions[Key] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function persistSessionOptions(
  record: SessionRecord,
  options: SessionAgentOptions | undefined,
): void {
  // Directory options are normalized against the session cwd so a record
  // reopened from another process directory resolves the same dirs.
  const normalized =
    options === undefined ? undefined : normalizeSessionDirOptions(options, record.cwd);
  const next = normalized === undefined ? undefined : persistedSessionOptions(normalized);
  if (next !== undefined) {
    record.acpx = {
      ...record.acpx,
      session_options: next,
    };
    return;
  }

  if (!record.acpx) {
    return;
  }

  delete record.acpx.session_options;
}

/**
 * Resolves relative dir entries against the session cwd. Shared by CLI flag
 * parsing and session-option normalization so both agree on the same dirs.
 */
export function resolveDirsAgainstCwd(
  dirs: readonly string[] | undefined,
  cwd: string,
): string[] | undefined {
  return dirs?.map((dir) => path.resolve(cwd, dir));
}

/**
 * Resolves relative skillsDirs/additionalDirs against the session cwd so the
 * initial session, persistence, and reconnects all agree on the same dirs.
 * Callers must normalize before constructing the client.
 */
export function normalizeSessionDirOptions(
  options: SessionAgentOptions,
  cwd: string,
): SessionAgentOptions {
  const normalized: SessionAgentOptions = { ...options };
  if (options.skillsDirs !== undefined) {
    normalized.skillsDirs = resolveDirsAgainstCwd(options.skillsDirs, cwd);
  }
  if (options.additionalDirs !== undefined) {
    normalized.additionalDirs = resolveDirsAgainstCwd(options.additionalDirs, cwd);
  }
  return normalized;
}

export function sessionOptionsFromRecord(record: SessionRecord): SessionAgentOptions | undefined {
  const stored = record.acpx?.session_options;
  if (!stored) {
    return undefined;
  }

  const sessionOptions: SessionAgentOptions = {};
  assignDefinedOption(sessionOptions, "model", nonEmptyString(stored.model));
  assignDefinedOption(sessionOptions, "allowedTools", storedAllowedTools(stored.allowed_tools));
  assignDefinedOption(sessionOptions, "maxTurns", storedMaxTurns(stored.max_turns));
  assignDefinedOption(
    sessionOptions,
    "systemPrompt",
    normalizeSystemPromptOption(stored.system_prompt),
  );
  assignDefinedOption(sessionOptions, "env", storedEnvRecord(stored.env));
  assignDefinedOption(sessionOptions, "skillsDirs", storedStringList(stored.skills_dirs));
  assignDefinedOption(sessionOptions, "additionalDirs", storedStringList(stored.additional_dirs));

  return Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined;
}

type PersistedSessionOptions = NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>;

function persistedSessionOptions(
  options: SessionAgentOptions,
): PersistedSessionOptions | undefined {
  const next = {
    model: nonEmptyString(options.model),
    allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : undefined,
    max_turns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
    system_prompt: normalizeSystemPromptOption(options.systemPrompt),
    env: storedEnvRecord(options.env),
    skills_dirs: storedStringList(options.skillsDirs),
    additional_dirs: storedStringList(options.additionalDirs),
  } satisfies PersistedSessionOptions;
  return hasPersistedSessionOptions(next) ? next : undefined;
}

export function hasPersistedSessionOptions(options: PersistedSessionOptions): boolean {
  return (
    options.model !== undefined ||
    options.allowed_tools !== undefined ||
    options.max_turns !== undefined ||
    options.system_prompt !== undefined ||
    options.env !== undefined ||
    options.skills_dirs !== undefined ||
    options.additional_dirs !== undefined
  );
}

function storedEnvRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== "string") {
      continue;
    }
    result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeSystemPromptOption(value: unknown): SystemPromptOption | undefined {
  const prompt = nonEmptyString(value);
  if (prompt !== undefined) {
    return prompt;
  }
  const append = appendedSystemPrompt(value);
  return append === undefined ? undefined : { append };
}

function appendedSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return nonEmptyString((value as { append?: unknown }).append);
}

function storedAllowedTools(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

// Unlike storedAllowedTools, empty entries and empty lists are dropped: an
// empty dir list carries no "clear" semantics worth persisting.
function storedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  const items = value.filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function storedMaxTurns(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
