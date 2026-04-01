import assert from "node:assert/strict";
import test from "node:test";
import {
  didUserScrollUp,
  isPinnedToBottom,
} from "../examples/flows/replay-viewer/src/hooks/use-sticky-auto-follow.js";

test("isPinnedToBottom treats near-bottom scroll positions as sticky", () => {
  assert.equal(
    isPinnedToBottom({
      scrollTop: 552,
      clientHeight: 400,
      scrollHeight: 1000,
    }),
    true,
  );
});

test("isPinnedToBottom disables follow when the reader scrolls away from the bottom", () => {
  assert.equal(
    isPinnedToBottom({
      scrollTop: 420,
      clientHeight: 400,
      scrollHeight: 1000,
    }),
    false,
  );
});

test("isPinnedToBottom honors a custom threshold", () => {
  assert.equal(
    isPinnedToBottom(
      {
        scrollTop: 530,
        clientHeight: 400,
        scrollHeight: 1000,
      },
      80,
    ),
    true,
  );
});

test("didUserScrollUp disables follow on small upward reader scrolls", () => {
  assert.equal(didUserScrollUp(980, 968), true);
  assert.equal(didUserScrollUp(980, 979), false);
  assert.equal(didUserScrollUp(980, 1000), false);
});
