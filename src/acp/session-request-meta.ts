const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 32;

function invalidMeta(): TypeError {
  return new TypeError(
    "sessionRequestMeta must return a plain JSON object within 256 KiB and 32 levels",
  );
}

function isJsonPrimitive(value: unknown): boolean {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidMeta();
    }
    return true;
  }
  return value === null || typeof value === "boolean" || typeof value === "string";
}

function isJsonContainer(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (Array.isArray(value) || prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

/** Reject JSON coercions so host policy cannot silently disappear on the wire. */
export function validateSessionRequestMeta(
  value: Record<string, unknown>,
): Record<string, unknown> {
  let nodes = 0;
  function check(current: unknown, depth: number): void {
    if (++nodes > MAX_BYTES || depth > MAX_DEPTH) {
      throw invalidMeta();
    }
    if (isJsonPrimitive(current)) {
      return;
    }
    if (!isJsonContainer(current)) {
      throw invalidMeta();
    }
    for (const item of Array.isArray(current) ? current : Object.values(current)) {
      check(item, depth + 1);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidMeta();
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) {
    throw invalidMeta();
  }
  return JSON.parse(json) as Record<string, unknown>;
}
