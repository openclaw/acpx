export type JsonObjectParseMode = "strict" | "fenced" | "compat";

export function parseJsonObject(
  text: string,
  options: {
    mode?: JsonObjectParseMode;
  } = {},
): unknown {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Expected JSON output, got empty text");
  }
  const mode = options.mode ?? "compat";

  const direct = tryParse(trimmed);
  if (direct.ok) {
    return direct.value;
  }

  if (mode === "fenced" || mode === "compat") {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch) {
      const fenced = tryParse(fencedMatch[1].trim());
      if (fenced.ok) {
        return fenced.value;
      }
    }
  }

  if (mode === "compat") {
    const balanced = extractBalancedJson(trimmed);
    if (balanced) {
      const parsed = tryParse(balanced);
      if (parsed.ok) {
        return parsed.value;
      }
    }
  }

  throw new Error(`Could not parse JSON from assistant output:\n${trimmed}`);
}

export function parseStrictJsonObject(text: string): unknown {
  return parseJsonObject(text, { mode: "strict" });
}

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

function extractBalancedJson(text: string): string | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") {
      continue;
    }

    const result = scanBalanced(text, index);
    if (result) {
      return result;
    }
  }

  return null;
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
