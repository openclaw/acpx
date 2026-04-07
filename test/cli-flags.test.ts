import assert from "node:assert/strict";
import test from "node:test";
import {
  hasExplicitPermissionModeFlag,
  resolvePermissionMode,
  resolveSystemPromptFlag,
} from "../src/cli/flags.js";

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

test("resolveSystemPromptFlag returns undefined when neither flag is set", () => {
  assert.equal(resolveSystemPromptFlag({}), undefined);
  assert.equal(resolveSystemPromptFlag({ systemPrompt: "" }), undefined);
  assert.equal(resolveSystemPromptFlag({ appendSystemPrompt: "" }), undefined);
});

test("resolveSystemPromptFlag returns string for --system-prompt", () => {
  assert.equal(
    resolveSystemPromptFlag({ systemPrompt: "you are an obsidian assistant" }),
    "you are an obsidian assistant",
  );
});

test("resolveSystemPromptFlag returns append object for --append-system-prompt", () => {
  assert.deepEqual(resolveSystemPromptFlag({ appendSystemPrompt: "always speak in spanish" }), {
    append: "always speak in spanish",
  });
});

test("resolveSystemPromptFlag rejects combining --system-prompt and --append-system-prompt", () => {
  assert.throws(
    () => resolveSystemPromptFlag({ systemPrompt: "a", appendSystemPrompt: "b" }),
    /Use only one of --system-prompt or --append-system-prompt/,
  );
});
