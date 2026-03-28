import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_REGISTRY,
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
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
    "qwen",
    "trae",
  ]);
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});
