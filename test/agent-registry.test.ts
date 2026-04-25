import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_REGISTRY,
  BUILT_IN_AGENT_PACKAGES,
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveBuiltInAgentLaunch,
  resolveInstalledBuiltInAgentLaunch,
  resolvePackageExecBuiltInAgentLaunch,
  resolveAgentCommand,
} from "../src/agent-registry.js";

test("resolveAgentCommand maps known agents to commands", () => {
  for (const [name, command] of Object.entries(AGENT_REGISTRY)) {
    assert.equal(resolveAgentCommand(name), command);
  }
});

test("resolveAgentCommand returns raw value for unknown agents", () => {
  assert.equal(resolveAgentCommand("custom-acp-server"), "custom-acp-server");
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
    "droid",
    "iflow",
    "kilocode",
    "kimi",
    "kiro",
    "opencode",
    "qoder",
    "qwen",
    "trae",
  ]);
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});

test("claude built-in uses the current ACP adapter package range", () => {
  assert.equal(BUILT_IN_AGENT_PACKAGES.claude.packageRange, "^0.31.0");
  assert.equal(AGENT_REGISTRY.claude, "npx -y @agentclientprotocol/claude-agent-acp@^0.31.0");
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
      version: "0.31.0",
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
    packageVersion: "0.31.0",
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
