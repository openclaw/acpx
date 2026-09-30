import { AGENT_ARGV_REGISTRY, AGENT_REGISTRY, BUILT_IN_AGENT_PACKAGES } from "../agent-registry.js";
import { splitCommandLine } from "./client-process.js";

// Every command string a built-in agent has shipped with. Saved session records
// keep the command they were created under, so a range change in
// agent-registry.ts must add the previous command here or those sessions drop
// out of agent-scoped lookup.
export const LEGACY_AGENT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  pi: ["npx pi-acp", "npx pi-acp@^0.0.22", "npx pi-acp@^0.0.26", "npx pi-acp@^0.0.31"],
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
    "npx -y @agentclientprotocol/claude-agent-acp@^0.24.2",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.25.0",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.31.0",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.36.1",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.37.0",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.60.0",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.76.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.25.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.31.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.36.1",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.37.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.60.0",
    "npm exec @agentclientprotocol/claude-agent-acp@^0.76.0",
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

function isFallbackCommand(name: string, agentCommand: string): boolean {
  const legacyCommands: readonly string[] =
    BUILT_IN_AGENT_PACKAGES[name]?.legacyFallbackCommands ?? [];
  return legacyCommands.includes(agentCommand);
}

/** Built-in agent whose current or earlier default command is exactly `agentCommand`. */
function builtInAgentForCommand(agentCommand: string): string | undefined {
  return (
    Object.keys(AGENT_REGISTRY).find((name) => AGENT_REGISTRY[name] === agentCommand) ??
    Object.keys(BUILT_IN_AGENT_PACKAGES).find((name) => isFallbackCommand(name, agentCommand)) ??
    Object.keys(LEGACY_AGENT_COMMANDS).find((name) =>
      LEGACY_AGENT_COMMANDS[name].includes(agentCommand),
    )
  );
}

export function resolveAgentArgvForCommand(agentCommand: string): string[] | undefined {
  const name = builtInAgentForCommand(agentCommand);
  return name ? currentArgv(name) : undefined;
}

function commandArgv(agentCommand: string): string[] {
  const { command, args } = splitCommandLine(agentCommand);
  return [command, ...args];
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function launchesBuiltIn(
  agentCommand: string,
  agentArgv: readonly string[] | undefined,
  name: string,
): boolean {
  return (
    agentArgv === undefined ||
    sameArgv(agentArgv, commandArgv(agentCommand)) ||
    sameArgv(agentArgv, AGENT_ARGV_REGISTRY[name] ?? [])
  );
}

export type AgentLaunchIdentity = { agentCommand: string; agentArgv?: string[] };

/**
 * Maps a saved launch identity from an earlier built-in default onto the current
 * built-in command and argv, so agent-scoped lookup keeps finding the session
 * after an adapter range change. Identities with a custom argv, and commands
 * acpx never shipped as a built-in default, are returned unchanged.
 */
export function migrateBuiltInAgentIdentity(
  agentCommand: string,
  agentArgv?: string[],
): AgentLaunchIdentity {
  const name = builtInAgentForCommand(agentCommand);
  const current = name ? AGENT_REGISTRY[name] : undefined;
  if (!name || !current || current === agentCommand) {
    return { agentCommand, agentArgv };
  }
  if (!launchesBuiltIn(agentCommand, agentArgv, name)) {
    return { agentCommand, agentArgv };
  }
  return { agentCommand: current, agentArgv: currentArgv(name) };
}

/** The agent command a session saved under `agentCommand` is filed under after migration. */
export function canonicalAgentCommand(agentCommand: string): string {
  return migrateBuiltInAgentIdentity(agentCommand).agentCommand;
}
