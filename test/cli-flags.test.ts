import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitPermissionModeFlag, resolvePermissionMode } from "../src/cli/flags.js";

test("resolvePermissionMode honors explicit approve-reads overrides", () => {
  assert.equal(resolvePermissionMode({ approveReads: true }, "approve-all"), "approve-reads");
  assert.equal(resolvePermissionMode({ approveAll: true }, "approve-reads"), "approve-all");
  assert.equal(resolvePermissionMode({ denyAll: true }, "approve-all"), "deny-all");
});

test("hasExplicitPermissionModeFlag detects explicit permission grants", () => {
  assert.equal(hasExplicitPermissionModeFlag({}), false);
  assert.equal(hasExplicitPermissionModeFlag({ approveReads: true }), true);
  assert.equal(hasExplicitPermissionModeFlag({ approveAll: true }), true);
  assert.equal(hasExplicitPermissionModeFlag({ denyAll: true }), true);
});
