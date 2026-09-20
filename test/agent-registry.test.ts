import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import {
  AGENT_ARGV_REGISTRY,
  AGENT_REGISTRY,
  BUILT_IN_AGENT_PACKAGES,
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveBuiltInAgentLaunch,
  resolveInstalledBuiltInAgentLaunch,
  resolvePackageExecBuiltInAgentLaunch,
  resolveAgentCommand,
  resolveAgentArgv,
  mergeAgentRegistry,
} from "../src/agent-registry.js";
import { createAgentRegistry } from "../src/agent-registry.js";

test("built-in command displays stay synchronized with structured argv", () => {
  assert.deepEqual(Object.keys(AGENT_ARGV_REGISTRY), Object.keys(AGENT_REGISTRY));
  for (const [name, argv] of Object.entries(AGENT_ARGV_REGISTRY)) {
    assert.equal(argv.join(" "), AGENT_REGISTRY[name]);
    assert.equal(normalizeAgentCommandInput(argv).agentCommand, AGENT_REGISTRY[name]);
  }
});

test("resolveAgentCommand maps known agents to commands", () => {
  assert.equal(resolveAgentCommand("devin"), "devin acp");
  assert.equal(resolveAgentCommand("fx"), "fx acp");
  assert.equal(resolveAgentCommand(" JUNIE "), "junie --acp=true");
  for (const [name, command] of Object.entries(AGENT_REGISTRY)) {
    assert.equal(resolveAgentCommand(name), command);
  }
});

test("resolveAgentCommand returns raw value for unknown agents", () => {
  assert.equal(resolveAgentCommand("custom-acp-server"), "custom-acp-server");
});

test("prototype property names remain raw commands unless explicitly configured", () => {
  const registry = createAgentRegistry();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(resolveAgentCommand(name), name);
    assert.equal(resolveAgentArgv(name), undefined);
    assert.equal(registry.resolve(name), name);
  }
});

test("registry overrides preserve prototype property names as own entries", () => {
  const overrides = Object.fromEntries([
    [" __proto__ ", " custom-proto --stdio "],
    ["constructor", "custom-constructor"],
  ]);
  const merged = mergeAgentRegistry(overrides);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  for (const name of ["__proto__", "constructor"]) {
    assert.equal(Object.hasOwn(merged, name), true);
    assert.equal(
      resolveAgentCommand(name, overrides),
      overrides[name === "__proto__" ? " __proto__ " : name].trim(),
    );
  }
  const argv = ["custom-proto", "literal argument"];
  const registry = createAgentRegistry({
    overrides: { ...overrides, " __proto__ ": argv },
    resolveExecutable: (command) => "/fixture/" + command,
  });
  assert.deepEqual(registry.resolve("__proto__"), argv);
  assert.equal(registry.resolve("constructor"), "custom-constructor");
  assert.equal(registry.list().includes("__proto__"), true);
  assert.deepEqual(registry.inspect("__proto__")?.launch, {
    kind: "installed",
    argv: ["/fixture/custom-proto", "literal argument"],
  });
});

test("antigravity uses the official ACP runtime and platform launch arguments", () => {
  const expected =
    process.platform === "win32"
      ? ["agy_acp_server.exe"]
      : ["agy_acp_server.par", ...(process.platform === "linux" ? ["--uid="] : [])];
  assert.deepEqual(AGENT_ARGV_REGISTRY.antigravity, expected);
  assert.equal(resolveAgentCommand("antigravity"), expected.join(" "));
  assert.equal(
    resolveAgentCommand("antigravity", { antigravity: "fleet-antigravity" }),
    "fleet-antigravity",
  );
});

test("resolveAgentCommand maps factory droid aliases to the droid command", () => {
  assert.equal(resolveAgentCommand("factory-droid"), AGENT_REGISTRY.droid);
  assert.equal(resolveAgentCommand("factorydroid"), AGENT_REGISTRY.droid);
});

test("resolveAgentCommand prefers explicit alias overrides over built-in alias mapping", () => {
  assert.equal(
    resolveAgentCommand("factory-droid", {
      "factory-droid": "custom-factory-droid --acp",
      droid: "custom-droid --acp",
    }),
    "custom-factory-droid --acp",
  );
});

test("trae built-in uses the standard traecli executable", () => {
  assert.equal(AGENT_REGISTRY.trae, "traecli acp serve");
  assert.equal(resolveAgentCommand("trae"), "traecli acp serve");
});

test("kiro built-in uses kiro-cli-chat directly", () => {
  assert.equal(AGENT_REGISTRY.kiro, "kiro-cli-chat acp");
  assert.equal(resolveAgentCommand("kiro"), "kiro-cli-chat acp");
});

test("mcode built-in launches the native MCode ACP server", () => {
  assert.equal(AGENT_REGISTRY.mcode, "mcode acp");
  assert.deepEqual(AGENT_ARGV_REGISTRY.mcode, ["mcode", "acp"]);
  assert.equal(resolveAgentCommand("mcode"), "mcode acp");
});

test("fast-agent built-in runs the ACP entrypoint through uvx", () => {
  assert.equal(AGENT_REGISTRY["fast-agent"], "uvx fast-agent-mcp acp");
  assert.equal(resolveAgentCommand("fast-agent"), "uvx fast-agent-mcp acp");
});

test("grok-build built-in runs the Grok Build ACP entrypoint", () => {
  assert.equal(AGENT_REGISTRY["grok-build"], "grok agent stdio");
  assert.equal(resolveAgentCommand("grok-build"), "grok agent stdio");
});

test("mux built-in runs the coder/mux ACP stdio bridge through npx", () => {
  assert.equal(AGENT_REGISTRY.mux, "npx -y mux@^0.28.0 acp");
  assert.equal(resolveAgentCommand("mux"), "npx -y mux@^0.28.0 acp");
});

test("pool built-in runs the Poolside ACP entrypoint", () => {
  assert.equal(AGENT_REGISTRY.pool, "pool acp");
  assert.deepEqual(AGENT_ARGV_REGISTRY.pool, ["pool", "acp"]);
  assert.equal(resolveAgentCommand("pool"), "pool acp");
});

test("zeroclaw built-in launches the native ZeroClaw ACP server", () => {
  assert.equal(AGENT_REGISTRY.zeroclaw, "zeroclaw acp");
  assert.deepEqual(AGENT_ARGV_REGISTRY.zeroclaw, ["zeroclaw", "acp"]);
  assert.equal(resolveAgentCommand("zeroclaw"), "zeroclaw acp");
});

test("listBuiltInAgents preserves the required example prefix and alphabetical tail", () => {
  const agents = listBuiltInAgents();
  assert.deepEqual(agents, Object.keys(AGENT_REGISTRY));
  assert.deepEqual(agents.slice(0, 7), [
    "pi",
    "openclaw",
    "codex",
    "claude",
    "gemini",
    "cursor",
    "copilot",
  ]);
  assert.deepEqual(agents.slice(7), [
    "antigravity",
    "devin",
    "droid",
    "fast-agent",
    "fx",
    "grok-build",
    "iflow",
    "junie",
    "kilocode",
    "kimi",
    "kiro",
    "mcode",
    "mux",
    "opencode",
    "pool",
    "qoder",
    "qwen",
    "trae",
    "zeroclaw",
  ]);
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});

test("claude built-in uses the current ACP adapter package range", () => {
  assert.equal(BUILT_IN_AGENT_PACKAGES.claude.packageRange, "^0.76.0");
  assert.equal(AGENT_REGISTRY.claude, "npx -y @agentclientprotocol/claude-agent-acp@^0.76.0");
});

test("npm-backed built-ins use current adapter package ranges", () => {
  assert.equal(BUILT_IN_AGENT_PACKAGES.codex.packageRange, "^1.1.5");
  assert.equal(AGENT_REGISTRY.codex, "npx -y @agentclientprotocol/codex-acp@^1.1.5");
  assert.equal(AGENT_REGISTRY.pi, "npx pi-acp@^0.0.33");
});

test("resolveInstalledBuiltInAgentLaunch uses a locally installed adapter when available", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-agent-registry-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(
    tempDir,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
  );
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: BUILT_IN_AGENT_PACKAGES.claude.packageName,
      version: "0.37.0",
      bin: {
        "claude-agent-acp": "bin/claude-agent-acp.js",
      },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(packageRoot, "bin", "claude-agent-acp.js"), "#!/usr/bin/env node\n");

  const launch = resolveInstalledBuiltInAgentLaunch(AGENT_REGISTRY.claude, {
    resolvePackageRoot: () => packageRoot,
  });

  assert.deepEqual(launch, {
    source: "installed",
    command: process.execPath,
    args: [path.join(packageRoot, "bin", "claude-agent-acp.js")],
    packageName: BUILT_IN_AGENT_PACKAGES.claude.packageName,
    packageRange: BUILT_IN_AGENT_PACKAGES.claude.packageRange,
    packageVersion: "0.37.0",
    binPath: path.join(packageRoot, "bin", "claude-agent-acp.js"),
  });
});

test("resolveInstalledBuiltInAgentLaunch ignores non-built-in commands", () => {
  assert.equal(resolveInstalledBuiltInAgentLaunch("custom-acp-server --stdio"), undefined);
});

test("resolvePackageExecBuiltInAgentLaunch bridges built-ins through the current Node npm CLI", () => {
  const npmCliPath = path.join(os.tmpdir(), "acpx-test-npm-cli.js");
  const launch = resolvePackageExecBuiltInAgentLaunch(AGENT_REGISTRY.codex, {
    execPath: "/tmp/node",
    existsSync: (candidate) => candidate === npmCliPath,
    resolveNpmCliPath: () => npmCliPath,
  });

  assert.deepEqual(launch, {
    source: "package-exec",
    command: "/tmp/node",
    args: [
      npmCliPath,
      "exec",
      "--yes",
      `--package=${BUILT_IN_AGENT_PACKAGES.codex.packageName}@${BUILT_IN_AGENT_PACKAGES.codex.packageRange}`,
      "--",
      BUILT_IN_AGENT_PACKAGES.codex.preferredBinName,
    ],
    packageName: BUILT_IN_AGENT_PACKAGES.codex.packageName,
    packageRange: BUILT_IN_AGENT_PACKAGES.codex.packageRange,
    npmCliPath,
  });
});

test("resolveBuiltInAgentLaunch accepts the legacy Claude npm exec default", () => {
  const npmCliPath = path.join(os.tmpdir(), "acpx-test-claude-npm-cli.js");
  const launch = resolveBuiltInAgentLaunch(
    `npm exec @agentclientprotocol/claude-agent-acp@${BUILT_IN_AGENT_PACKAGES.claude.packageRange}`,
    {
      execPath: "/tmp/node",
      existsSync: (candidate) => candidate === npmCliPath,
      resolvePackageRoot: () => {
        throw new Error("adapter not installed");
      },
      resolveNpmCliPath: () => npmCliPath,
    },
  );

  assert.deepEqual(launch, {
    source: "package-exec",
    command: "/tmp/node",
    args: [
      npmCliPath,
      "exec",
      "--yes",
      `--package=${BUILT_IN_AGENT_PACKAGES.claude.packageName}@${BUILT_IN_AGENT_PACKAGES.claude.packageRange}`,
      "--",
      BUILT_IN_AGENT_PACKAGES.claude.preferredBinName,
    ],
    packageName: BUILT_IN_AGENT_PACKAGES.claude.packageName,
    packageRange: BUILT_IN_AGENT_PACKAGES.claude.packageRange,
    npmCliPath,
  });
});

test("public inspection resolves installed direct agents without running package executors", () => {
  const commands: string[] = [];
  const registry = createAgentRegistry({
    resolveExecutable: (command) => {
      commands.push(command);
      return command === "opencode" ? "/fixture/bin/opencode" : undefined;
    },
  });
  assert.deepEqual(registry.inspect("opencode"), {
    id: "opencode",
    name: "OpenCode",
    launch: { kind: "installed", argv: ["/fixture/bin/opencode", "acp"] },
  });
  assert.deepEqual(commands, ["opencode"]);
  assert.deepEqual(registry.inspect("qwen"), {
    id: "qwen",
    name: "Qwen Code",
    launch: { kind: "missing", requirements: [{ kind: "command", name: "qwen" }] },
  });
  assert.deepEqual(registry.resolve("opencode"), AGENT_ARGV_REGISTRY.opencode);
});

test("public inspection respects custom overrides and never accepts package-exec readiness", () => {
  const registry = createAgentRegistry({
    overrides: { opencode: ["custom-agent", "--stdio"], qwen: ["npx", "custom-qwen"] },
    resolveExecutable: (command) => "/fixture/" + command,
  });
  assert.deepEqual(registry.inspect("opencode")?.launch, {
    kind: "installed",
    argv: ["/fixture/custom-agent", "--stdio"],
  });
  assert.equal(registry.inspect("qwen"), undefined);
  assert.deepEqual(registry.resolve("qwen"), ["npx", "custom-qwen"]);
  for (const id of ["not-registered", "constructor", "__proto__"]) {
    assert.equal(registry.inspect(id), undefined);
  }
  const configured = createAgentRegistry({
    overrides: { constructor: ["custom-agent", "--stdio"] },
    resolveExecutable: (command) => "/fixture/" + command,
  });
  assert.deepEqual(configured.inspect("constructor"), {
    id: "constructor",
    name: "constructor",
    launch: { kind: "installed", argv: ["/fixture/custom-agent", "--stdio"] },
  });
});

test("public inspection requires Pi's native command and refreshes installation facts", () => {
  const installed = new Set(["pi-acp"]);
  const registry = createAgentRegistry({
    resolveExecutable: (command) => (installed.has(command) ? "/fixture/" + command : undefined),
    resolvePackageRoot: () => undefined,
  });
  assert.deepEqual(registry.inspect("pi")?.launch, {
    kind: "missing",
    requirements: [{ kind: "command", name: "pi" }],
  });
  installed.add("pi");
  assert.deepEqual(registry.inspect("pi")?.launch, {
    kind: "installed",
    argv: ["/fixture/pi-acp"],
  });
  installed.delete("pi-acp");
  assert.deepEqual(registry.inspect("pi")?.launch, {
    kind: "missing",
    requirements: [{ kind: "package", name: "pi-acp" }],
  });
});

test("public inspection resolves a plugin-local adapter package without executing its entrypoint", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-inspect-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const bin = path.join(temp, "adapter.js");
  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "pi-acp", version: "0.0.33", bin: { "pi-acp": "adapter.js" } }),
  );
  fs.writeFileSync(bin, 'throw new Error("inspection must not execute an adapter");');
  const registry = createAgentRegistry({
    resolveExecutable: (command) => (command === "pi" ? "/fixture/pi" : undefined),
    resolvePackageRoot: (name) => (name === "pi-acp" ? temp : undefined),
  });
  assert.deepEqual(registry.inspect("pi")?.launch, {
    kind: "installed",
    argv: [process.execPath, bin],
  });
  fs.unlinkSync(bin);
  assert.deepEqual(registry.inspect("pi")?.launch, {
    kind: "missing",
    requirements: [{ kind: "package", name: "pi-acp" }],
  });
});

test("public inspection keeps alias overrides and raw argv values intact", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-inspect-command-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const executable = path.join(temp, "adapter with spaces");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const argv = [executable, "--stdio", "literal argument"];
  const registry = createAgentRegistry({
    overrides: { "factory-droid": argv, droid: "missing-other-adapter" },
  });
  assert.deepEqual(registry.inspect("factory-droid"), {
    id: "droid",
    name: "Factory Droid",
    launch: { kind: "installed", argv },
  });
  assert.deepEqual(registry.resolve("factory-droid"), argv);
  const configured = createAgentRegistry({
    overrides: { fixture: JSON.stringify(executable) + " --stdio" },
  });
  assert.deepEqual(configured.inspect("fixture")?.launch, {
    kind: "installed",
    argv: [executable, "--stdio"],
  });
});

test("public inspection excludes installed package executor aliases", () => {
  for (const command of ["bun x custom-adapter", "uv tool run custom-adapter"]) {
    const registry = createAgentRegistry({
      overrides: { fixture: command },
      resolveExecutable: (name) => "/fixture/" + name,
    });
    assert.equal(registry.inspect("fixture"), undefined);
    assert.equal(registry.resolve("fixture"), command);
  }
});
