import { AcpClient } from "../../acp/client.js";
import { DEFAULT_AGENT_NAME } from "../../agent-registry.js";
import type { AcpRuntimeOptions } from "./contract.js";

export type RuntimeHealthReport = {
  ok: boolean;
  message: string;
  details?: string[];
};

export type ProbeRuntimeDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

export async function probeRuntime(
  options: AcpRuntimeOptions,
  deps: ProbeRuntimeDeps = {},
): Promise<RuntimeHealthReport> {
  const agentName = options.probeAgent?.trim() || DEFAULT_AGENT_NAME;
  const agentCommand = options.agentRegistry.resolve(agentName);
  const client =
    deps.clientFactory?.({
      agentCommand,
      cwd: options.cwd,
      mcpServers: [...(options.mcpServers ?? [])],
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      verbose: options.verbose,
    }) ??
    new AcpClient({
      agentCommand,
      cwd: options.cwd,
      mcpServers: [...(options.mcpServers ?? [])],
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      verbose: options.verbose,
    });

  try {
    await client.start();
    return {
      ok: true,
      message: "embedded ACP runtime ready",
      details: [
        `agent=${agentName}`,
        `command=${agentCommand}`,
        `cwd=${options.cwd}`,
        ...(client.initializeResult?.protocolVersion
          ? [`protocolVersion=${client.initializeResult.protocolVersion}`]
          : []),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      message: "embedded ACP runtime probe failed",
      details: [
        `agent=${agentName}`,
        `command=${agentCommand}`,
        `cwd=${options.cwd}`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  } finally {
    await client.close().catch(() => {});
  }
}
