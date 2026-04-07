import type { SessionRecord } from "../../types.js";

export type SystemPromptOption = string | { append: string };

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
};

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
