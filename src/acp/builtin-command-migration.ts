import { AGENT_ARGV_REGISTRY, AGENT_REGISTRY, BUILT_IN_AGENT_PACKAGES } from "../agent-registry.js";

const LEGACY_AGENT_COMMANDS: Record<string, string[]> = {
  pi: ["npx pi-acp", "npx pi-acp@^0.0.22", "npx pi-acp@^0.0.26"],
  codex: [
    "npx @zed-industries/codex-acp",
    "npx @zed-industries/codex-acp@^0.9.5",
    "npx @zed-industries/codex-acp@^0.10.0",
    "npx @zed-industries/codex-acp@^0.11.1",
    "npx @zed-industries/codex-acp@^0.12.0",
    "npx -y @agentclientprotocol/codex-acp@^0.0.44",
    "npx -y @agentclientprotocol/codex-acp@^1.1.4",
  ],
  claude: [
    "npx @zed-industries/claude-agent-acp",
    "npx -y @zed-industries/claude-agent-acp",
    "npx -y @zed-industries/claude-agent-acp@^0.21.0",
    "npx -y @zed-industries/claude-agent-acp@^0.23.1",
    "npx -y @zed-industries/claude-agent-acp@^0.24.2",
    "npx -y @zed-industries/claude-agent-acp@^0.25.0",
    "npx -y @zed-industries/claude-agent-acp@^0.31.0",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.36.1",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.36.1",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.37.0",
  ],
  gemini: ["gemini", "gemini --experimental-acp"],
  kiro: ["kiro-cli acp"],
  mux: ["npx -y mux@^0.27.0 acp"],
  opencode: ["npx opencode-ai"],
};

function currentArgv(name: string): string[] | undefined {
  const argv = AGENT_ARGV_REGISTRY[name];
  return argv ? [...argv] : undefined;
}

export function resolveAgentArgvForCommand(agentCommand: string): string[] | undefined {
  for (const [name, command] of Object.entries(AGENT_REGISTRY)) {
    if (command === agentCommand) {
      return currentArgv(name);
    }
  }
  for (const [name, spec] of Object.entries(BUILT_IN_AGENT_PACKAGES)) {
    const legacyCommands: readonly string[] = spec.legacyFallbackCommands ?? [];
    if (legacyCommands.includes(agentCommand)) {
      return currentArgv(name);
    }
  }
  for (const [name, commands] of Object.entries(LEGACY_AGENT_COMMANDS)) {
    if (commands.includes(agentCommand)) {
      return currentArgv(name);
    }
  }
  return undefined;
}
