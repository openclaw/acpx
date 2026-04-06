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
  resolveInstalledBuiltInAgentLaunch,
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
      version: "0.25.0",
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
    command: process.execPath,
    args: [path.join(packageRoot, "bin", "claude-agent-acp.js")],
    packageName: BUILT_IN_AGENT_PACKAGES.claude.packageName,
    packageVersion: "0.25.0",
    binPath: path.join(packageRoot, "bin", "claude-agent-acp.js"),
  });
});

test("resolveInstalledBuiltInAgentLaunch ignores non-built-in commands", () => {
  assert.equal(resolveInstalledBuiltInAgentLaunch("custom-acp-server --stdio"), undefined);
});
