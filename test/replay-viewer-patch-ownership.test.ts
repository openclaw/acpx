import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReplayPatch,
  createReplayPatch,
} from "../examples/flows/replay-viewer/src/lib/json-patch-plus.js";
import type { ReplayJsonPatchOperation } from "../examples/flows/replay-viewer/src/types.js";

for (const fails of [false, true]) {
  test(`consecutive appends preserve input payloads (${fails ? "failed batch" : "success"})`, () => {
    const state = { rows: [] as Array<{ items: string[] }> };
    const payload = { items: [] as string[] };
    const operations: ReplayJsonPatchOperation[] = [
      { op: "append", path: "/rows", value: payload },
      { op: "append", path: "/rows/0/items", value: "private edit" },
    ];
    if (fails) {
      operations.push({ op: "test", path: "/rows/0/items", value: [] });
    }
    const before = structuredClone(operations);
    if (fails) {
      assert.throws(() => applyReplayPatch(state, operations), { name: "TEST_OPERATION_FAILED" });
    } else {
      assert.deepEqual(applyReplayPatch(state, operations), {
        rows: [{ items: ["private edit"] }],
      });
    }
    assert.deepEqual(operations, before);
    assert.deepEqual(payload, { items: [] });
    assert.deepEqual(state, { rows: [] });
  });
}

for (const insertion of ["add", "replace", "append"] as const) {
  test(`${insertion} payloads stay unchanged during later patch operations`, () => {
    const payload = { label: "borrowed", nested: { count: 1 }, items: [] as string[] };
    const state = {
      left: { label: "initial", nested: { count: 0 }, items: [] as string[] },
      right: { label: "initial", nested: { count: 0 }, items: [] as string[] },
      rows: [] as Array<typeof payload>,
    };
    const firstPath = insertion === "append" ? "/rows/0" : "/left";
    const operations: ReplayJsonPatchOperation[] = [
      { op: insertion, path: insertion === "append" ? "/rows" : "/left", value: payload },
      { op: insertion, path: insertion === "append" ? "/rows" : "/right", value: payload },
      { op: "replace", path: `${firstPath}/nested/count`, value: 7 },
      { op: "append", path: `${firstPath}/items`, value: "private edit" },
    ];
    const beforeState = structuredClone(state);
    const beforeOperations = structuredClone(operations);
    const next = applyReplayPatch(state, operations);
    const first = insertion === "append" ? next.rows[0] : next.left;
    const second = insertion === "append" ? next.rows[1] : next.right;
    assert(first && second);
    assert.deepEqual(first, { label: "borrowed", nested: { count: 7 }, items: ["private edit"] });
    assert.deepEqual(second, { label: "borrowed", nested: { count: 1 }, items: [] });
    assert.deepEqual(state, beforeState);
    assert.deepEqual(operations, beforeOperations);
    assert.deepEqual(payload, { label: "borrowed", nested: { count: 1 }, items: [] });
  });
}

test("root replacement is the working document for later operations without borrowing its value", () => {
  const state = { old: true };
  const replacement = { text: "new", rows: [] as Array<{ text: string }> };
  const operations: ReplayJsonPatchOperation[] = [
    { op: "replace", path: "", value: replacement },
    { op: "add", path: "/rows/-", value: { text: "first" } },
    { op: "replace", path: "/rows/0/text", value: "edited" },
    { op: "append", path: "/text", value: "!" },
    { op: "test", path: "/rows/0/text", value: "edited" },
  ];
  const beforeOperations = structuredClone(operations);
  assert.deepEqual(applyReplayPatch(state, operations), {
    text: "new!",
    rows: [{ text: "edited" }],
  });
  assert.deepEqual(state, { old: true });
  assert.deepEqual(replacement, { text: "new", rows: [] });
  assert.deepEqual(operations, beforeOperations);
});

test("root remove followed by root add retains ordinary JSON Patch sequencing", () => {
  const state = { old: true };
  const replacement = { count: 1 };
  assert.deepEqual(
    applyReplayPatch(state, [
      { op: "remove", path: "" },
      { op: "add", path: "", value: replacement },
      { op: "replace", path: "/count", value: 2 },
    ]),
    { count: 2 },
  );
  assert.deepEqual(state, { old: true });
  assert.deepEqual(replacement, { count: 1 });
});

for (const op of ["move", "copy"] as const) {
  test(`${op} to root returns the new document and preserves caller state`, () => {
    const state = { source: { text: "hello", items: [1] }, other: true };
    const before = structuredClone(state);
    const operations: ReplayJsonPatchOperation[] = [
      { op, from: "/source", path: "" },
      { op: "append", path: "/text", value: "!" },
    ];
    const beforeOperations = structuredClone(operations);
    assert.deepEqual(applyReplayPatch(state, operations), { text: "hello!", items: [1] });
    assert.deepEqual(state, before);
    assert.deepEqual(operations, beforeOperations);
  });
}

const invalidTails: Array<{
  operation: ReplayJsonPatchOperation;
  expected: RegExp | { name: string };
}> = [
  {
    operation: { op: "test", path: "/count", value: 99 },
    expected: { name: "TEST_OPERATION_FAILED" },
  },
  {
    operation: { op: "replace", path: "/missing", value: 2 },
    expected: { name: "OPERATION_PATH_UNRESOLVABLE" },
  },
  {
    operation: { op: "add", path: "/invalid", value: undefined },
    expected: { name: "OPERATION_VALUE_REQUIRED" },
  },
  {
    operation: { op: "append", path: "/text", value: 2 },
    expected: /append requires a string value/,
  },
  {
    operation: { op: "append", path: "/count", value: "no" },
    expected: /append target must be a string or array/,
  },
];
for (const { operation, expected } of invalidTails) {
  test(`late ${operation.op} failure at ${operation.path} preserves caller state and payloads`, () => {
    const state = { text: "original", count: 1, messages: [] as object[] };
    const payload = { labels: ["original"] };
    const operations: ReplayJsonPatchOperation[] = [
      { op: "add", path: "/draft", value: payload },
      { op: "replace", path: "/draft/labels/0", value: "private edit" },
      { op: "append", path: "/messages", value: { text: "not published" } },
      operation,
    ];
    const beforeState = structuredClone(state);
    const beforeOperations = structuredClone(operations);
    assert.throws(() => applyReplayPatch(state, operations), expected);
    assert.deepEqual(state, beforeState);
    assert.deepEqual(operations, beforeOperations);
    assert.deepEqual(payload, { labels: ["original"] });
  });
}

for (const key of ["__proto__", "prototype", "constructor"]) {
  for (const member of ["path", "from"] as const) {
    test(`late unsafe ${member} rejects ${key} without publishing prior work`, () => {
      const state = { text: "original" };
      const operation: ReplayJsonPatchOperation =
        member === "path"
          ? { op: "add", path: `/${key}/polluted`, value: true }
          : { op: "copy", from: `/${key}/polluted`, path: "/copy" };
      assert.throws(
        () =>
          applyReplayPatch(state, [
            { op: "append", path: "/text", value: " private edit" },
            operation,
          ]),
        /Unsafe JSON Pointer key/,
      );
      assert.deepEqual(state, { text: "original" });
      assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    });
  }
}

test("normalization advances array length and preserves escaped pointer semantics", () => {
  const previous = { "a/b": { "~text": "hel" }, rows: [{ id: 1 }], enabled: true };
  const next = {
    "a/b": { "~text": "hello" },
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    enabled: false,
  };
  const beforePrevious = structuredClone(previous);
  const beforeNext = structuredClone(next);
  const operations = createReplayPatch(previous, next);
  assert.deepEqual(
    operations.filter((op) => op.path === "/rows"),
    [
      { op: "append", path: "/rows", value: { id: 2 } },
      { op: "append", path: "/rows", value: { id: 3 } },
    ],
  );
  assert(
    operations.some((op) => op.op === "append" && op.path === "/a~1b/~0text" && op.value === "lo"),
  );
  const emitted = structuredClone(operations);
  assert.deepEqual(applyReplayPatch(previous, operations), next);
  assert.deepEqual(operations, emitted);
  assert.deepEqual(previous, beforePrevious);
  assert.deepEqual(next, beforeNext);
});

test("creating a root shape change does not write through borrowed next-state references", () => {
  const previous = [{ legacy: true }];
  const next = { title: "replacement", rows: [{ text: "new" }] };
  const rows = next.rows;
  const firstRow = next.rows[0];
  const beforePrevious = structuredClone(previous);
  const beforeNext = structuredClone(next);
  const operations = createReplayPatch<object>(previous, next);
  assert.equal(next.rows, rows, "scratch simulation must not replace a caller-owned property");
  assert.equal(next.rows[0], firstRow);
  const emitted = structuredClone(operations);
  assert.deepEqual(applyReplayPatch<object>(previous, operations), beforeNext);
  assert.deepEqual(operations, emitted);
  assert.deepEqual(previous, beforePrevious);
  assert.deepEqual(next, beforeNext);
  assert.equal(next.rows, rows);
});
