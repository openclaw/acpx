import { extractAgentSessionId, normalizeAgentSessionId } from "../acp/agent-session-id.js";

export function normalizeRuntimeSessionId(value: unknown): string | undefined {
  return normalizeAgentSessionId(value);
}

export function extractRuntimeSessionId(meta: unknown): string | undefined {
  return extractAgentSessionId(meta);
}
