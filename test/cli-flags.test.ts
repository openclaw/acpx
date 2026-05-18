import assert from "node:assert/strict";
import test from "node:test";
import type { Command } from "commander";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import {
  parseAllowedTools,
  parseAuthPolicy,
  parseMaxTurns,
  parseNonInteractivePermissionPolicy,
  parseOutputFormat,
  parsePromptRetries,
  parseSessionName,
  parseTimeoutSeconds,
  parseTtlSeconds,
  hasExplicitPermissionModeFlag,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  resolveSessionNameFromFlags,
  resolveSystemPromptFlag,
} from "../src/cli/flags.js";

function config(overrides: Partial<ResolvedAcpxConfig> = {}): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
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
    globalPath: "/tmp/global-config.json",
    projectPath: "/tmp/project-config.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
    ...overrides,
  };
}

function commandWithOptions(options: Record<string, unknown>): Command {
  return {
    optsWithGlobals: () => options,
  } as unknown as Command;
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

test("flag parsers reject invalid enum values with actionable messages", () => {
  assert.equal(parseOutputFormat("json"), "json");
  assert.throws(() => parseOutputFormat("xml"), /Invalid format "xml".*text, json, quiet/);

  assert.equal(parseAuthPolicy("fail"), "fail");
  assert.throws(() => parseAuthPolicy("prompt"), /Invalid auth policy "prompt".*skip, fail/);

  assert.equal(parseNonInteractivePermissionPolicy("deny"), "deny");
  assert.throws(
    () => parseNonInteractivePermissionPolicy("ask"),
    /Invalid non-interactive permission policy "ask".*deny, fail/,
  );
});

test("numeric flag parsers reject non-finite and out-of-range values", () => {
  assert.equal(parseTimeoutSeconds("1.5"), 1500);
  assert.throws(() => parseTimeoutSeconds("0"), /positive number/);
  assert.throws(() => parseTimeoutSeconds("abc"), /positive number/);

  assert.equal(parseTtlSeconds("0"), 0);
  assert.equal(parseTtlSeconds("2.25"), 2250);
  assert.throws(() => parseTtlSeconds("-1"), /non-negative/);

  assert.equal(parseMaxTurns("2"), 2);
  assert.throws(() => parseMaxTurns("0"), /positive integer/);
  assert.throws(() => parseMaxTurns("1.5"), /positive integer/);

  assert.equal(parsePromptRetries("0"), 0);
  assert.equal(parsePromptRetries("3"), 3);
  assert.throws(() => parsePromptRetries("-1"), /non-negative integer/);
  assert.throws(() => parsePromptRetries("1.5"), /non-negative integer/);
});

test("string list flag parsers normalize valid values and reject empty entries", () => {
  assert.equal(parseSessionName(" docs "), "docs");
  assert.throws(() => parseSessionName(" "), /must not be empty/);

  assert.deepEqual(parseAllowedTools(""), []);
  assert.deepEqual(parseAllowedTools("Read, Edit , Bash"), ["Read", "Edit", "Bash"]);
  assert.throws(() => parseAllowedTools("Read,,Edit"), /without empty entries/);
});

test("resolvePermissionMode rejects conflicting permission flags", () => {
  assert.throws(
    () => resolvePermissionMode({ approveAll: true, denyAll: true }, "approve-reads"),
    /Use only one permission mode/,
  );
});

test("resolveGlobalFlags validates and normalizes dynamic Commander options", () => {
  const flags = resolveGlobalFlags(
    commandWithOptions({
      agent: "claude",
      cwd: "/repo",
      authPolicy: "fail",
      nonInteractivePermissions: "fail",
      permissionPolicy: "{\"defaultAction\":\"deny\"}",
      jsonStrict: true,
      suppressReads: true,
      terminal: false,
      timeout: 12_000,
      ttl: 34_000,
      verbose: false,
      format: "json",
      model: " opus ",
      allowedTools: ["Read", "Edit"],
      maxTurns: 3,
      systemPrompt: "replace",
      promptRetries: 2,
      approveReads: true,
    }),
    config({ authPolicy: "skip", nonInteractivePermissions: "deny", format: "text" }),
  );

  assert.deepEqual(flags, {
    agent: "claude",
    cwd: "/repo",
    authPolicy: "fail",
    nonInteractivePermissions: "fail",
    permissionPolicy: "{\"defaultAction\":\"deny\"}",
    jsonStrict: true,
    suppressReads: true,
    terminal: false,
    timeout: 12_000,
    ttl: 34_000,
    verbose: false,
    format: "json",
    model: "opus",
    allowedTools: ["Read", "Edit"],
    maxTurns: 3,
    systemPrompt: "replace",
    promptRetries: 2,
    approveAll: undefined,
    approveReads: true,
    denyAll: undefined,
  });
});

test("resolveGlobalFlags ignores malformed dynamic options and keeps typed config defaults", () => {
  const flags = resolveGlobalFlags(
    commandWithOptions({
      agent: 42,
      cwd: false,
      timeout: "12000",
      ttl: "34000",
      format: undefined,
      allowedTools: ["Read", 7],
      maxTurns: "3",
      promptRetries: "2",
    }),
    config({
      authPolicy: "skip",
      nonInteractivePermissions: "deny",
      format: "quiet",
      timeoutMs: 5000,
      ttlMs: 6000,
    }),
  );

  assert.equal(flags.agent, undefined);
  assert.equal(flags.cwd, process.cwd());
  assert.equal(flags.authPolicy, "skip");
  assert.equal(flags.nonInteractivePermissions, "deny");
  assert.equal(flags.timeout, 5000);
  assert.equal(flags.ttl, 6000);
  assert.equal(flags.format, "quiet");
  assert.equal(flags.allowedTools, undefined);
  assert.equal(flags.maxTurns, undefined);
  assert.equal(flags.promptRetries, undefined);
});

test("resolveGlobalFlags rejects conflicting permission policy aliases", () => {
  assert.throws(
    () =>
      resolveGlobalFlags(
        commandWithOptions({ permissionPolicy: "{\"defaultAction\":\"deny\"}", policy: "file" }),
        config(),
      ),
    /Use only one permission policy flag/,
  );
});

test("resolveSessionNameFromFlags falls back through global and parent command options", () => {
  assert.equal(
    resolveSessionNameFromFlags({ session: "direct" }, commandWithOptions({})),
    "direct",
  );

  assert.equal(
    resolveSessionNameFromFlags({} as const, commandWithOptions({ session: "global" })),
    "global",
  );

  const command = {
    optsWithGlobals: () => ({}),
    parent: {
      opts: () => ({ session: "parent" }),
    },
  } as unknown as Command;
  assert.equal(resolveSessionNameFromFlags({}, command), "parent");
});

test("resolveOutputPolicy maps json-strict output behavior", () => {
  assert.deepEqual(resolveOutputPolicy("json", true), {
    format: "json",
    jsonStrict: true,
    suppressReads: false,
    suppressNonJsonStderr: true,
    queueErrorAlreadyEmitted: true,
    suppressSdkConsoleErrors: true,
  });

  assert.deepEqual(resolveOutputPolicy("quiet", false), {
    format: "quiet",
    jsonStrict: false,
    suppressReads: false,
    suppressNonJsonStderr: false,
    queueErrorAlreadyEmitted: false,
    suppressSdkConsoleErrors: false,
  });
});

test("resolveAgentInvocation rejects conflicting positional and override agents", () => {
  assert.throws(
    () =>
      resolveAgentInvocation(
        "claude",
        {
          agent: "codex",
          cwd: "/repo",
          nonInteractivePermissions: "deny",
          ttl: 300_000,
          format: "text",
        },
        config(),
      ),
    /Do not combine positional agent with --agent override/,
  );
});
