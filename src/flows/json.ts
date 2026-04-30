export type JsonObjectParseMode = "strict" | "fenced" | "compat";

function normalizeJsonText(text: unknown): string {
  if (typeof text === "string") {
    return text.trim();
  }
  if (text == null) {
    return "";
  }
  if (
    typeof text === "number" ||
    typeof text === "boolean" ||
    typeof text === "bigint" ||
    typeof text === "symbol"
  ) {
    return String(text).trim();
  }
  return "";
}

// The generic entrypoint when a workflow wants to choose its tolerance level
// explicitly. Most callers should still use one of the small helpers below.
export function parseJsonObject(
  text: string,
  options: {
    mode?: JsonObjectParseMode;
  } = {},
): unknown {
  const trimmed = normalizeJsonText(text);
  if (!trimmed) {
    throw new Error("Expected JSON output, got empty text");
  }
  const mode = options.mode ?? "compat";

  const direct = tryParse(trimmed);
  if (direct.ok) {
    return direct.value;
  }

  if (mode === "fenced" || mode === "compat") {
    const fencedText = extractFencedJsonText(trimmed);
    if (fencedText !== null) {
      const fenced = tryParse(fencedText);
      if (fenced.ok) {
        return fenced.value;
      }
    }
  }

  if (mode === "compat") {
    for (const candidate of extractBalancedJsonCandidates(trimmed)) {
      const parsed = tryParse(candidate);
      if (parsed.ok) {
        return parsed.value;
      }
    }
  }

  throw new Error(`Could not parse JSON from assistant output:\n${trimmed}`);
}

// Use this when the model contract must be exact JSON and any extra text
// should fail the step immediately.
export function parseStrictJsonObject(text: string): unknown {
  return parseJsonObject(text, { mode: "strict" });
}

// Default workflow parser: direct JSON first, fenced JSON second, and finally
// a balanced embedded object for compatibility with chatty model output.
export function extractJsonObject(text: string): unknown {
  return parseJsonObject(text, { mode: "compat" });
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    };
  } catch {
    return {
      ok: false,
    };
  }
}

function extractFencedJsonText(text: string): string | null {
  const openingFenceIndex = text.indexOf("```");
  if (openingFenceIndex === -1) {
    return null;
  }

  let contentStart = openingFenceIndex + 3;
  if (
    text.slice(contentStart, contentStart + 4).toLowerCase() === "json" &&
    isFenceWhitespace(text[contentStart + 4])
  ) {
    contentStart += 4;
  }

  while (isFenceWhitespace(text[contentStart])) {
    contentStart += 1;
  }

  const closingFenceIndex = text.indexOf("```", contentStart);
  if (closingFenceIndex === -1) {
    return null;
  }

  return text.slice(contentStart, closingFenceIndex).trim();
}

function isFenceWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") {
      continue;
    }

    const result = scanBalanced(text, index);
    if (result) {
      candidates.push(result);
    }
  }

  return candidates;
}

function scanBalanced(text: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char !== "}" && char !== "]") {
      continue;
    }

    const last = stack.at(-1);
    if ((last === "{" && char !== "}") || (last === "[" && char !== "]")) {
      return null;
    }

    stack.pop();
    if (stack.length === 0) {
      return text.slice(startIndex, index + 1);
    }
  }

  return null;
}
