import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveAgentCommand,
} from "../src/agent-registry.js";

test("resolveAgentCommand maps known agents to commands", () => {
  const expected = new Map<string, string>([
    ["copilot", "copilot --acp --stdio"],
    ["codex", "npx @zed-industries/codex-acp"],
    ["cursor", "cursor-agent acp"],
    ["claude", "npx -y @zed-industries/claude-agent-acp"],
    ["gemini", "gemini --experimental-acp"],
    ["openclaw", "openclaw acp"],
    ["kimi", "kimi acp"],
    ["opencode", "npx -y opencode-ai acp"],
    ["kiro", "kiro-cli acp"],
    ["pi", "npx pi-acp"],
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

test("listBuiltInAgents returns exactly all 12 registered agent names", () => {
  const agents = listBuiltInAgents();
  assert.equal(agents.length, 12);
  assert.deepEqual(
    new Set(agents),
    new Set([
      "copilot",
      "codex",
      "cursor",
      "claude",
      "gemini",
      "openclaw",
      "kimi",
      "opencode",
      "kiro",
      "pi",
      "kilocode",
      "qwen",
    ]),
  );
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});
