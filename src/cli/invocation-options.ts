import { InvalidArgumentError } from "commander";
import { loadPermissionPolicySpec } from "../permission-policy.js";
import type {
  SessionConnectionOptions,
  SessionCreateOptions,
} from "../session/execution/contracts.js";
import type { AgentProcessEnvironment, PermissionPolicy } from "../types.js";
import type { AgentEnvConfig, ResolvedAcpxConfig } from "./config.js";
import type { GlobalFlags } from "./flags.js";

export function sessionOptionsFromGlobalFlags(
  globalFlags: GlobalFlags,
): NonNullable<SessionCreateOptions["sessionOptions"]> {
  return {
    model: globalFlags.model,
    allowedTools: globalFlags.allowedTools,
    maxTurns: globalFlags.maxTurns,
    systemPrompt: globalFlags.systemPrompt,
  };
}

export function sessionConnectionOptions(
  globalFlags: GlobalFlags,
  config: ResolvedAcpxConfig,
  agent?: { agentEnv?: AgentEnvConfig },
): SessionConnectionOptions {
  return {
    agentProcessEnvironment: agentProcessEnvironment(agent?.agentEnv),
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    fs: globalFlags.fs,
    terminal: globalFlags.terminal,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  };
}

export async function resolvePermissionPolicyFromFlags(
  globalFlags: GlobalFlags,
): Promise<PermissionPolicy | undefined> {
  try {
    return await loadPermissionPolicySpec(globalFlags.permissionPolicy, globalFlags.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(`Invalid permission policy: ${message}`);
  }
}

export function agentProcessEnvironment(
  agentEnv: AgentEnvConfig | undefined,
): AgentProcessEnvironment | undefined {
  return (
    agentEnv && {
      agentProcessEnvAllow: agentEnv.envAllow,
      agentProcessEnvBlock: agentEnv.envBlock,
      agentProcessEnv: agentEnv.env,
    }
  );
}
