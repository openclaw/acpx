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
};

export function mergeSessionOptions(
  preferred: SessionAgentOptions | undefined,
  fallback: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  const merged: SessionAgentOptions = { ...fallback };
  assignDefinedOption(merged, "model", preferred?.model);
  assignDefinedOption(merged, "allowedTools", preferred?.allowedTools);
  assignDefinedOption(merged, "maxTurns", preferred?.maxTurns);
  assignDefinedOption(merged, "systemPrompt", preferred?.systemPrompt);
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
  const next = options === undefined ? undefined : persistedSessionOptions(options);
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

export function sessionOptionsFromRecord(record: SessionRecord): SessionAgentOptions | undefined {
  const stored = record.acpx?.session_options;
  if (!stored) {
    return undefined;
  }

  const sessionOptions: SessionAgentOptions = {};
  assignStoredOption(sessionOptions, "model", nonEmptyString(stored.model));
  assignStoredOption(sessionOptions, "allowedTools", storedAllowedTools(stored.allowed_tools));
  assignStoredOption(sessionOptions, "maxTurns", storedMaxTurns(stored.max_turns));
  assignStoredOption(
    sessionOptions,
    "systemPrompt",
    storedSystemPromptOption(stored.system_prompt),
  );
  assignStoredOption(sessionOptions, "env", storedEnvRecord(stored.env));

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
  } satisfies PersistedSessionOptions;
  return hasPersistedSessionOptions(next) ? next : undefined;
}

function hasPersistedSessionOptions(options: PersistedSessionOptions): boolean {
  return (
    options.model !== undefined ||
    options.allowed_tools !== undefined ||
    options.max_turns !== undefined ||
    options.system_prompt !== undefined ||
    options.env !== undefined
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

function assignStoredOption<Key extends keyof SessionAgentOptions>(
  target: SessionAgentOptions,
  key: Key,
  value: SessionAgentOptions[Key] | undefined,
): void {
  assignDefinedOption(target, key, value);
}

function storedAllowedTools(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function storedMaxTurns(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function storedSystemPromptOption(value: unknown): SystemPromptOption | undefined {
  return normalizeSystemPromptOption(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
