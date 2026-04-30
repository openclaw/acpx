import fastJsonPatch from "fast-json-patch";
import type { ReplayJsonPatchOperation } from "../types.js";

export function applyReplayPatch<TState extends object>(
  state: TState,
  ops: ReplayJsonPatchOperation[],
): TState {
  let nextDocument = structuredClone(state) as unknown;

  for (const op of ops) {
    assertSafePatchOperation(op);
    if (op.op === "append") {
      applyAppendOperation(nextDocument, op.path, op.value);
      continue;
    }

    nextDocument = fastJsonPatch.applyPatch(nextDocument, [op], true, false).newDocument;
  }

  return nextDocument as TState;
}

export function createReplayPatch<TState extends object>(
  previousState: TState,
  nextState: TState,
): ReplayJsonPatchOperation[] {
  const rawOps = fastJsonPatch.compare(previousState, nextState) as ReplayJsonPatchOperation[];
  if (rawOps.length === 0) {
    return rawOps;
  }

  const normalized: ReplayJsonPatchOperation[] = [];
  let workingState = structuredClone(previousState);

  for (const op of rawOps) {
    const nextOp = normalizeReplayOperation(workingState, op);
    normalized.push(nextOp);
    workingState = applyReplayPatch(workingState, [nextOp]);
  }

  return normalized;
}

function normalizeReplayOperation(
  state: object,
  op: ReplayJsonPatchOperation,
): ReplayJsonPatchOperation {
  if (op.op === "replace") {
    const currentValue = getValueAtPointer(state, op.path);
    if (
      typeof currentValue === "string" &&
      typeof op.value === "string" &&
      op.value.startsWith(currentValue)
    ) {
      return {
        op: "append",
        path: op.path,
        value: op.value.slice(currentValue.length),
      };
    }
    return op;
  }

  if (op.op === "add") {
    const parentInfo = resolveParentPointer(state, op.path);
    if (
      parentInfo &&
      Array.isArray(parentInfo.parent) &&
      parentInfo.lastToken !== "-" &&
      /^[0-9]+$/.test(parentInfo.lastToken)
    ) {
      const index = Number(parentInfo.lastToken);
      if (index === parentInfo.parent.length) {
        return {
          op: "append",
          path: parentInfo.parentPath,
          value: op.value,
        };
      }
    }
    return op;
  }

  return op;
}

function applyAppendOperation(document: unknown, path: string, value: unknown): void {
  const target = getValueAtPointer(document, path);

  if (typeof target === "string") {
    if (typeof value !== "string") {
      throw new Error(`JSON Patch+ append requires a string value at string path ${path}`);
    }
    setValueAtPointer(document, path, `${target}${value}`);
    return;
  }

  if (Array.isArray(target)) {
    target.push(value);
    return;
  }

  throw new Error(`JSON Patch+ append target must be a string or array at ${path}`);
}

function decodePointer(path: string): string[] {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: ${path}`);
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getValueAtPointer(document: unknown, path: string): unknown {
  let current = document;

  for (const token of decodePointer(path)) {
    if (Array.isArray(current)) {
      if (token === "-") {
        throw new Error(`Cannot dereference '-' in JSON Pointer: ${path}`);
      }
      const index = Number(token);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (current && typeof current === "object") {
      assertSafeObjectKey(token, path);
      current = (current as Record<string, unknown>)[token];
      continue;
    }

    return undefined;
  }

  return current;
}

function setValueAtPointer(document: unknown, path: string, value: unknown): void {
  const parentInfo = resolveParentPointer(document, path);
  if (!parentInfo) {
    throw new Error(`Cannot replace the root document with append at ${path}`);
  }

  const { parent, lastToken } = parentInfo;
  if (Array.isArray(parent)) {
    if (lastToken === "-") {
      parent.push(value);
      return;
    }
    const index = Number(lastToken);
    if (!Number.isInteger(index)) {
      throw new Error(`Invalid array index in JSON Pointer: ${path}`);
    }
    parent[index] = value;
    return;
  }

  if (!parent || typeof parent !== "object") {
    throw new Error(`Cannot set value at non-object parent for ${path}`);
  }
  assertSafeObjectKey(lastToken, path);
  Object.defineProperty(parent, lastToken, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function resolveParentPointer(
  document: unknown,
  path: string,
): { parent: unknown; parentPath: string; lastToken: string } | null {
  const tokens = decodePointer(path);
  if (tokens.length === 0) {
    return null;
  }

  let current = document;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (Array.isArray(current)) {
      const arrayIndex = Number(token);
      if (!Number.isInteger(arrayIndex)) {
        throw new Error(`Invalid array index in JSON Pointer: ${path}`);
      }
      current = current[arrayIndex];
      continue;
    }
    if (!current || typeof current !== "object") {
      throw new Error(`Invalid JSON Pointer parent for ${path}`);
    }
    assertSafeObjectKey(token, path);
    current = (current as Record<string, unknown>)[token];
  }

  return {
    parent: current,
    parentPath:
      tokens.length === 1
        ? ""
        : `/${tokens
            .slice(0, -1)
            .map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1"))
            .join("/")}`,
    lastToken: tokens.at(-1)!,
  };
}

function assertSafePatchOperation(op: ReplayJsonPatchOperation): void {
  assertSafePointer(op.path);
  if ("from" in op) {
    assertSafePointer(op.from);
  }
}

function assertSafePointer(path: string): void {
  for (const token of decodePointer(path)) {
    assertSafeObjectKey(token, path);
  }
}

function assertSafeObjectKey(token: string, path: string): void {
  if (token === "__proto__" || token === "prototype" || token === "constructor") {
    throw new Error(`Unsafe JSON Pointer key in ${path}`);
  }
}
