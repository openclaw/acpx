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

function isPrimitiveDetail(value: unknown): boolean {
  return (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  );
}

function formatFunctionDetail(value: Function): string {
  return value.name ? `[Function ${value.name}]` : "[Function]";
}

function serializeRuntimeDetail(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key: string, nested: unknown): unknown => {
    if (nested instanceof Error) {
      return nested.message || nested.name;
    }
    if (nested && typeof nested === "object") {
      if (seen.has(nested)) {
        return "[Circular]";
      }
      seen.add(nested);
    }
    return nested;
  });
  return serialized ?? "undefined";
}

export function formatRuntimeDetail(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  if (isPrimitiveDetail(value)) {
    return String(value);
  }
  if (typeof value === "function") {
    return formatFunctionDetail(value);
  }

  try {
    return serializeRuntimeDetail(value);
  } catch {
    return "unserializable object";
  }
}

export function normalizeRuntimeDetails(
  details: readonly unknown[] | undefined,
): string[] | undefined {
  return details?.map((detail) => formatRuntimeDetail(detail));
}

export async function probeRuntime(
  options: AcpRuntimeOptions,
  deps: ProbeRuntimeDeps = {},
): Promise<RuntimeHealthReport> {
  const agentName = options.probeAgent?.trim() || DEFAULT_AGENT_NAME;
  const agentCommand = options.agentRegistry.resolve(agentName);
  const client = createProbeClient(options, agentCommand, deps);

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
        formatRuntimeDetail(error),
      ],
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function createProbeClient(
  options: AcpRuntimeOptions,
  agentCommand: string,
  deps: ProbeRuntimeDeps,
): AcpClient {
  const clientOptions = {
    agentCommand,
    cwd: options.cwd,
    mcpServers: [...(options.mcpServers ?? [])],
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    verbose: options.verbose,
  };
  return deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
}
