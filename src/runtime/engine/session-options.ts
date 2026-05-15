import type { SessionRecord } from "../../types.js";

export type SystemPromptOption = string | { append: string };

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
};

export function mergeSessionOptions(
  preferred: SessionAgentOptions | undefined,
  fallback: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  const merged: SessionAgentOptions = { ...fallback };

  if (preferred?.model !== undefined) {
    merged.model = preferred.model;
  }
  if (preferred?.allowedTools !== undefined) {
    merged.allowedTools = preferred.allowedTools;
  }
  if (preferred?.maxTurns !== undefined) {
    merged.maxTurns = preferred.maxTurns;
  }
  if (preferred?.systemPrompt !== undefined) {
    merged.systemPrompt = preferred.systemPrompt;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function persistSessionOptions(
  record: SessionRecord,
  options: SessionAgentOptions | undefined,
): void {
  const systemPromptOption = options?.systemPrompt;
  const normalizedSystemPrompt =
    typeof systemPromptOption === "string" && systemPromptOption.length > 0
      ? systemPromptOption
      : systemPromptOption &&
          typeof systemPromptOption === "object" &&
          typeof systemPromptOption.append === "string" &&
          systemPromptOption.append.length > 0
        ? { append: systemPromptOption.append }
        : undefined;

  const next =
    options &&
    ({
      model: typeof options.model === "string" ? options.model : undefined,
      allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : undefined,
      max_turns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
      system_prompt: normalizedSystemPrompt,
    } satisfies NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>);

  const hasValues = Boolean(
    next &&
    ((typeof next.model === "string" && next.model.trim().length > 0) ||
      Array.isArray(next.allowed_tools) ||
      typeof next.max_turns === "number" ||
      next.system_prompt !== undefined),
  );

  if (hasValues && next) {
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

  if (typeof stored.model === "string" && stored.model.trim().length > 0) {
    sessionOptions.model = stored.model;
  }
  if (Array.isArray(stored.allowed_tools)) {
    sessionOptions.allowedTools = [...stored.allowed_tools];
  }
  if (typeof stored.max_turns === "number") {
    sessionOptions.maxTurns = stored.max_turns;
  }
  const storedSystemPrompt = stored.system_prompt;
  if (typeof storedSystemPrompt === "string" && storedSystemPrompt.length > 0) {
    sessionOptions.systemPrompt = storedSystemPrompt;
  } else if (
    storedSystemPrompt &&
    typeof storedSystemPrompt === "object" &&
    typeof (storedSystemPrompt as { append?: unknown }).append === "string" &&
    (storedSystemPrompt as { append: string }).append.length > 0
  ) {
    sessionOptions.systemPrompt = { append: (storedSystemPrompt as { append: string }).append };
  }

  return Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined;
}
