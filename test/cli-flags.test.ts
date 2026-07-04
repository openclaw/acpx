import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import {
  addGlobalFlags,
  addPromptInputOption,
  addSessionNameOption,
  addSessionOption,
  parseAllowedTools,
  parseAuthPolicy,
  parseDaysOlderThan,
  parseHistoryLimit,
  parseMaxTurns,
  parseNonInteractivePermissionPolicy,
  parseNonEmptyValue,
  parseOutputFormat,
  parsePruneBeforeDate,
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

function parseCommand(command: Command, argv: string[]): Command {
  command.exitOverride();
  command.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  return command.parse(["node", "acpx", ...argv], { from: "node" });
}

test("resolvePermissionMode honors explicit approve-reads overrides", () => {
  assert.equal(resolvePermissionMode({}, "approve-reads"), "approve-reads");
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

  assert.equal(parseNonEmptyValue("Model", " sonnet "), "sonnet");
  assert.throws(() => parseNonEmptyValue("Model", " "), /Model must not be empty/);

  assert.deepEqual(parseAllowedTools(""), []);
  assert.deepEqual(parseAllowedTools("   "), []);
  assert.deepEqual(parseAllowedTools("Read, Edit , Bash"), ["Read", "Edit", "Bash"]);
  assert.throws(() => parseAllowedTools("Read,,Edit"), /without empty entries/);
});

test("history and prune parsers validate positive numbers and dates", () => {
  assert.equal(parseHistoryLimit("3"), 3);
  assert.throws(() => parseHistoryLimit("0"), /positive integer/);
  assert.throws(() => parseHistoryLimit("2.5"), /positive integer/);

  assert.equal(parseDaysOlderThan("14"), 14);
  assert.throws(() => parseDaysOlderThan("0"), /positive integer number of days/);
  assert.throws(() => parseDaysOlderThan("tomorrow"), /positive integer number of days/);

  assert.equal(parsePruneBeforeDate("2026-01-01").toISOString(), "2026-01-01T00:00:00.000Z");
  assert.throws(() => parsePruneBeforeDate("not-a-date"), /valid date/);
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
      permissionPolicy: '{"defaultAction":"deny"}',
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
    permissionPolicy: '{"defaultAction":"deny"}',
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

test("resolveGlobalFlags treats non-object Commander options as absent", () => {
  const flags = resolveGlobalFlags(
    {
      optsWithGlobals: () => [],
    } as unknown as Command,
    config({
      authPolicy: "fail",
      nonInteractivePermissions: "fail",
      ttlMs: 1_234,
      format: "quiet",
    }),
  );

  assert.equal(flags.authPolicy, "fail");
  assert.equal(flags.nonInteractivePermissions, "fail");
  assert.equal(flags.ttl, 1_234);
  assert.equal(flags.format, "quiet");
  assert.equal(flags.suppressReads, false);
  assert.equal(flags.approveAll, undefined);
  assert.equal(flags.approveReads, undefined);
  assert.equal(flags.denyAll, undefined);
});

test("resolveGlobalFlags preserves boolean flag intent and alias-only policy values", () => {
  const approveAllFlags = resolveGlobalFlags(
    commandWithOptions({
      approveAll: true,
      policy: "policy.json",
      terminal: true,
    }),
    config(),
  );

  assert.equal(approveAllFlags.approveAll, true);
  assert.equal(approveAllFlags.approveReads, undefined);
  assert.equal(approveAllFlags.denyAll, undefined);
  assert.equal(approveAllFlags.permissionPolicy, "policy.json");
  assert.equal(approveAllFlags.terminal, undefined);

  const denyAllFlags = resolveGlobalFlags(
    commandWithOptions({
      denyAll: true,
    }),
    config(),
  );
  assert.equal(denyAllFlags.approveAll, undefined);
  assert.equal(denyAllFlags.denyAll, true);

  const fallbackFormat = resolveGlobalFlags(
    commandWithOptions({}),
    config({ format: undefined as never }),
  );
  assert.equal(fallbackFormat.format, "text");
});

test("resolveGlobalFlags rejects conflicting permission policy aliases", () => {
  assert.throws(
    () =>
      resolveGlobalFlags(
        commandWithOptions({ permissionPolicy: '{"defaultAction":"deny"}', policy: "file" }),
        config(),
      ),
    /Use only one permission policy flag/,
  );
});

test("resolveGlobalFlags rejects invalid json-strict combinations", () => {
  assert.throws(
    () => resolveGlobalFlags(commandWithOptions({ jsonStrict: true, format: "text" }), config()),
    /--json-strict requires --format json/,
  );
  assert.throws(
    () =>
      resolveGlobalFlags(
        commandWithOptions({ jsonStrict: true, format: "json", verbose: true }),
        config(),
      ),
    /--json-strict cannot be combined with --verbose/,
  );
});

test("global flag registration parses each supported option", () => {
  const command = parseCommand(addGlobalFlags(new Command()), [
    "--agent",
    "claude",
    "--cwd",
    "/tmp",
    "--auth-policy",
    "fail",
    "--approve-all",
    "--non-interactive-permissions",
    "fail",
    "--permission-policy",
    '{"defaultAction":"deny"}',
    "--format",
    "json",
    "--suppress-reads",
    "--model",
    "sonnet",
    "--allowed-tools",
    "Read,Edit",
    "--max-turns",
    "4",
    "--system-prompt",
    "be precise",
    "--prompt-retries",
    "2",
    "--json-strict",
    "--no-terminal",
    "--timeout",
    "1.5",
    "--ttl",
    "0",
    "--verbose",
  ]);

  assert.deepEqual(command.opts(), {
    agent: "claude",
    cwd: "/tmp",
    authPolicy: "fail",
    approveAll: true,
    nonInteractivePermissions: "fail",
    permissionPolicy: '{"defaultAction":"deny"}',
    format: "json",
    suppressReads: true,
    model: "sonnet",
    allowedTools: ["Read", "Edit"],
    maxTurns: 4,
    systemPrompt: "be precise",
    promptRetries: 2,
    jsonStrict: true,
    terminal: false,
    timeout: 1500,
    ttl: 0,
    verbose: true,
  });
});

test("global flag registration validates option parsers at parse time", () => {
  assert.throws(
    () => parseCommand(addGlobalFlags(new Command()), ["--auth-policy", "prompt"]),
    /Invalid auth policy/,
  );
  assert.throws(
    () => parseCommand(addGlobalFlags(new Command()), ["--max-turns", "0"]),
    /Max turns must be a positive integer/,
  );
  assert.throws(
    () => parseCommand(addGlobalFlags(new Command()), ["--system-prompt", ""]),
    /System prompt must not be empty/,
  );
  assert.throws(
    () => parseCommand(addGlobalFlags(new Command()), ["--append-system-prompt", ""]),
    /Append system prompt must not be empty/,
  );
});

test("session and prompt option registration parse command-local flags", () => {
  const sessionCommand = parseCommand(addSessionOption(new Command()), [
    "--session",
    " docs ",
    "--no-wait",
  ]);
  assert.deepEqual(sessionCommand.opts(), { session: "docs", wait: false });

  const sessionNameCommand = parseCommand(addSessionNameOption(new Command()), ["-s", " review "]);
  assert.deepEqual(sessionNameCommand.opts(), { session: "review" });

  const promptCommand = parseCommand(addPromptInputOption(new Command()), ["--file", "-"]);
  assert.deepEqual(promptCommand.opts(), { file: "-" });
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

  const commandWithoutCommanderHelpers = {} as unknown as Command;
  assert.equal(resolveSessionNameFromFlags({}, commandWithoutCommanderHelpers), undefined);
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
    suppressSdkConsoleErrors: true,
  });
});

test("resolveAgentInvocation rejects conflicting positional and override agents", () => {
  const fallback = resolveAgentInvocation(
    undefined,
    {
      cwd: "/repo",
      nonInteractivePermissions: "deny",
      ttl: 300_000,
      format: "text",
    },
    config({ defaultAgent: undefined as never }),
  );
  assert.equal(fallback.agentName, "codex");
  assert.match(fallback.agentCommand, /codex-acp/);
  assert.equal(fallback.cwd, "/repo");

  assert.deepEqual(
    resolveAgentInvocation(
      undefined,
      {
        agent: " custom-acp ",
        cwd: "/repo",
        nonInteractivePermissions: "deny",
        ttl: 300_000,
        format: "text",
      },
      config({ defaultAgent: "claude" }),
    ),
    {
      agentName: "claude",
      agentCommand: "custom-acp",
      cwd: "/repo",
    },
  );

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
