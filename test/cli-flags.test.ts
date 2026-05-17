import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import {
  addGlobalFlags,
  hasExplicitPermissionModeFlag,
  resolveGlobalFlags,
  resolvePermissionMode,
  resolveSystemPromptFlag,
} from "../src/cli/flags.js";

function buildTestConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "claude-code",
    defaultPermissions: "approve-reads",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 300_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    globalPath: "/tmp/acpx-flags-test/global.json",
    projectPath: "/tmp/acpx-flags-test/project.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  };
}

function parseFlags(argv: string[]): ReturnType<typeof resolveGlobalFlags> {
  const command = new Command();
  command.exitOverride();
  addGlobalFlags(command);
  command.action(() => {});
  command.parse(argv, { from: "user" });
  return resolveGlobalFlags(command, buildTestConfig());
}

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

test("resolveGlobalFlags: --json-strict with no explicit retries defaults to 1", () => {
  const flags = parseFlags(["--format", "json", "--json-strict"]);
  assert.equal(flags.jsonStrict, true);
  assert.equal(flags.promptRetries, 1);
});

test("resolveGlobalFlags: --json-strict with --prompt-retries 0 honors zero", () => {
  const flags = parseFlags(["--format", "json", "--json-strict", "--prompt-retries", "0"]);
  assert.equal(flags.jsonStrict, true);
  assert.equal(flags.promptRetries, 0);
});

test("resolveGlobalFlags: --json-strict with --prompt-retries 3 honors three", () => {
  const flags = parseFlags(["--format", "json", "--json-strict", "--prompt-retries", "3"]);
  assert.equal(flags.jsonStrict, true);
  assert.equal(flags.promptRetries, 3);
});

test("resolveGlobalFlags: non-strict with no explicit retries leaves promptRetries undefined", () => {
  const flags = parseFlags([]);
  assert.equal(flags.jsonStrict, false);
  assert.equal(flags.promptRetries, undefined);
});
