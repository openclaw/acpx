const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.22",
  codex: "^0.9.5",
  claude: "^0.21.0",
} as const;

export const AGENT_REGISTRY: Record<string, string> = {
  pi: `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`,
  openclaw: "openclaw acp",
  codex: `npx @zed-industries/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`,
  claude: `npx -y @zed-industries/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
  gemini: "gemini --experimental-acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  kimi: "kimi acp",
  opencode: "npx -y opencode-ai acp",
  kiro: "kiro-cli acp",
  kilocode: "npx -y @kilocode/cli acp",
  qwen: "qwen --acp",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function mergeAgentRegistry(overrides?: Record<string, string>): Record<string, string> {
  if (!overrides) {
    return { ...AGENT_REGISTRY };
  }

  const merged = { ...AGENT_REGISTRY };
  for (const [name, command] of Object.entries(overrides)) {
    const normalized = normalizeAgentName(name);
    if (!normalized || !command.trim()) {
      continue;
    }
    merged[normalized] = command.trim();
  }
  return merged;
}

export function resolveAgentCommand(agentName: string, overrides?: Record<string, string>): string {
  const normalized = normalizeAgentName(agentName);
  const registry = mergeAgentRegistry(overrides);
  return registry[normalized] ?? agentName;
}

export function listBuiltInAgents(overrides?: Record<string, string>): string[] {
  return Object.keys(mergeAgentRegistry(overrides));
}
