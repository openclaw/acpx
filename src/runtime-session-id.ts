const RUNTIME_SESSION_ID_META_KEYS = [
  "runtimeSessionId",
  "providerSessionId",
  "codexSessionId",
  "claudeSessionId",
] as const;

function asMetaRecord(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return meta as Record<string, unknown>;
}

export function extractRuntimeSessionId(meta: unknown): string | undefined {
  const record = asMetaRecord(meta);
  if (!record) {
    return undefined;
  }

  for (const key of RUNTIME_SESSION_ID_META_KEYS) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

export { RUNTIME_SESSION_ID_META_KEYS };
