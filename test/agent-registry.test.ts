import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveAgentCommand,
} from "../src/agent-registry.js";

test("resolveAgentCommand maps known agents to commands", () => {
  const expected = new Map<string, string>([
    ["pi", "npx pi-acp"],
    ["openclaw", "openclaw acp"],
    ["codex", "npx @zed-industries/codex-acp"],
    ["claude", "npx -y @zed-industries/claude-agent-acp"],
    ["gemini", "gemini --experimental-acp"],
    ["cursor", "cursor-agent acp"],
    ["copilot", "copilot --acp --stdio"],
    ["kimi", "kimi acp"],
    ["opencode", "npx -y opencode-ai acp"],
    ["kiro", "kiro-cli acp"],
    ["kilocode", "npx -y @kilocode/cli acp"],
    ["qwen", "qwen --acp"],
  ]);

  for (const [name, command] of expected) {
    assert.equal(resolveAgentCommand(name), command);
  }
});

test("resolveAgentCommand returns raw value for unknown agents", () => {
  assert.equal(resolveAgentCommand("custom-acp-server"), "custom-acp-server");
});

test("listBuiltInAgents preserves the required built-in example order", () => {
  const agents = listBuiltInAgents();
  assert.deepEqual(agents, [
    "pi",
    "openclaw",
    "codex",
    "claude",
    "gemini",
    "cursor",
    "copilot",
    "kimi",
    "opencode",
    "kiro",
    "kilocode",
    "qwen",
  ]);
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});
