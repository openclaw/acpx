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

  const fenced = parseFencedJsonIfAllowed(trimmed, mode);
  if (fenced.ok) {
    return fenced.value;
  }

  if (mode === "compat") {
    const balanced = parseBalancedJsonCandidate(trimmed);
    if (balanced.ok) {
      return balanced.value;
    }
  }

  throw new Error(`Could not parse JSON from assistant output:\n${trimmed}`);
}

function parseFencedJsonIfAllowed(
  text: string,
  mode: JsonObjectParseMode,
): { ok: true; value: unknown } | { ok: false } {
  if (mode !== "fenced" && mode !== "compat") {
    return { ok: false };
  }
  const fencedText = extractFencedJsonText(text);
  return fencedText === null ? { ok: false } : tryParse(fencedText);
}

const COMPAT_JSON_WORK_MULTIPLIER = 8;

type JsonRecoveryBudget = { remaining: number };

function consumeRecoveryWork(budget: JsonRecoveryBudget, units: number): boolean {
  if (units > budget.remaining) {
    budget.remaining = 0;
    return false;
  }
  budget.remaining -= units;
  return true;
}

function parseBalancedJsonCandidate(text: string): { ok: true; value: unknown } | { ok: false } {
  const budget = { remaining: text.length * COMPAT_JSON_WORK_MULTIPLIER };
  for (let index = 0; index < text.length && budget.remaining > 0; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") {
      continue;
    }
    const end = scanBalanced(text, index, budget);
    if (end === null) {
      continue;
    }
    // Reserve parsing work before allocating a slice, including failed parses.
    if (!consumeRecoveryWork(budget, end - index)) {
      return { ok: false };
    }
    const parsed = tryParse(text.slice(index, end));
    if (parsed.ok) {
      return parsed;
    }
  }
  return { ok: false };
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

  const closingFenceIndex = findClosingJsonFence(text, contentStart);
  if (closingFenceIndex === -1) {
    return null;
  }

  return text.slice(contentStart, closingFenceIndex).trim();
}

function findClosingJsonFence(text: string, contentStart: number): number {
  let inString = false;
  let escaped = false;
  for (let index = contentStart; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      const next = scanStringChar(char, escaped);
      escaped = next.escaped;
      inString = next.inString;
    } else if (char === '"') {
      inString = true;
    } else if (text.startsWith("```", index)) {
      return index;
    }
  }
  return -1;
}

function isFenceWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function scanBalanced(text: string, startIndex: number, budget: JsonRecoveryBudget): number | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    if (!consumeRecoveryWork(budget, 1)) {
      return null;
    }
    const char = text[index];

    if (inString) {
      const next = scanStringChar(char, escaped);
      escaped = next.escaped;
      inString = next.inString;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    const result = scanBalancedToken(index, char, stack);
    if (result !== SCAN_CONTINUE) {
      return result;
    }
  }

  return null;
}

const SCAN_CONTINUE = Symbol("scan-continue");

function scanBalancedToken(
  index: number,
  char: string,
  stack: string[],
): number | null | typeof SCAN_CONTINUE {
  if (char === "{" || char === "[") {
    stack.push(char);
    return SCAN_CONTINUE;
  }

  if (char !== "}" && char !== "]") {
    return SCAN_CONTINUE;
  }

  if (!balancedClosingTokenMatches(stack.at(-1), char)) {
    return null;
  }

  stack.pop();
  return stack.length === 0 ? index + 1 : SCAN_CONTINUE;
}

function balancedClosingTokenMatches(open: string | undefined, close: string): boolean {
  if (open === "{") {
    return close === "}";
  }
  if (open === "[") {
    return close === "]";
  }
  return false;
}

function scanStringChar(char: string, escaped: boolean): { escaped: boolean; inString: boolean } {
  if (escaped) {
    return { escaped: false, inString: true };
  }
  if (char === "\\") {
    return { escaped: true, inString: true };
  }
  return { escaped: false, inString: char !== '"' };
}
