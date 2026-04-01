import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReplayPatch,
  createReplayPatch,
} from "../examples/flows/replay-viewer/src/lib/json-patch-plus.js";
import type { ReplayJsonPatchOperation } from "../examples/flows/replay-viewer/src/types.js";

test("applyReplayPatch supports JSON Patch+ append for strings and arrays", () => {
  const state = {
    text: "hel",
    items: [1],
  };

  const ops: ReplayJsonPatchOperation[] = [
    { op: "append", path: "/text", value: "lo" },
    { op: "append", path: "/items", value: 2 },
  ];

  const next = applyReplayPatch(state, ops);

  assert.deepEqual(next, {
    text: "hello",
    items: [1, 2],
  });
});

test("createReplayPatch normalizes string growth and array growth to JSON Patch+ append", () => {
  const previous = {
    text: "hel",
    items: [1],
    nested: {
      events: [{ seq: 1 }],
    },
  };

  const next = {
    text: "hello",
    items: [1, 2],
    nested: {
      events: [{ seq: 1 }, { seq: 2 }],
    },
  };

  const ops = createReplayPatch(previous, next);

  assert.deepEqual(
    ops.slice().toSorted((left, right) => left.path.localeCompare(right.path)),
    [
      { op: "append", path: "/items", value: 2 },
      { op: "append", path: "/nested/events", value: { seq: 2 } },
      { op: "append", path: "/text", value: "lo" },
    ],
  );
  assert.deepEqual(applyReplayPatch(previous, ops), next);
});
