import { normalizeAgentCommandInput } from "../../acp/client-process.js";
import { AcpClient } from "../../acp/client.js";
import { DEFAULT_AGENT_NAME } from "../../agent-registry.js";
import { TimeoutError } from "../../async-control.js";
import type { AcpRuntimeOptions, AcpRuntimeSessionModels } from "./contract.js";

export type RuntimeHealthReport = {
  ok: boolean;
  message: string;
  details?: string[];
};

export type ProbeRuntimeDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};

export type InspectAgentModelsOptions = {
  agentCommand: string[];
  cwd: string;
  signal?: AbortSignal;
  /** Positive startup/session discovery deadline; defaults to 120 seconds. Cleanup is awaited. */
  timeoutMs?: number;
  /** Trusted child-only environment overlay; never persisted. */
  agentProcessEnv?: Record<string, string>;
};

/**
 * Inspect session model metadata without a runtime store or prompt. The agent
 * may create native session history; only its owned transport is closed.
 */
export async function inspectAgentModels(
  options: InspectAgentModelsOptions,
): Promise<AcpRuntimeSessionModels | undefined> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Model inspection timeoutMs must be positive and at most 2147483647");
  }
  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const assertActive = () => signal.throwIfAborted();
  const client = new AcpClient({
    ...normalizeAgentCommandInput(options.agentCommand),
    cwd: options.cwd,
    agentProcessEnv: options.agentProcessEnv,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    fs: false,
    terminal: false,
    processLifecycle: {
      onBeforeSpawn: assertActive,
      onSpawned: assertActive,
    },
  });
  const timer = setTimeout(() => deadline.abort(new TimeoutError(timeoutMs)), timeoutMs);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const inspection = (async () => {
    assertActive();
    await client.start();
    assertActive();
    const { models } = await client.createSession();
    assertActive();
    return models
      ? {
          currentModelId: models.currentModelId,
          availableModelIds: models.availableModels.map((model) => model.modelId),
          availableModels: models.availableModels,
        }
      : undefined;
  })();
  try {
    return await Promise.race([inspection, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // Interrupt outstanding ACP requests, then settle startup as well: close()
    // alone can run before an asynchronous launch has acquired its child.
    try {
      if (signal.aborted) {
        await client.close();
      }
    } finally {
      await inspection.catch(() => {});
      await client.close();
    }
  }
}

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
  const agentCommand = normalizeAgentCommandInput(options.agentRegistry.resolve(agentName));
  const client = createProbeClient(options, agentName, agentCommand, deps);

  try {
    await client.start();
    return {
      ok: true,
      message: "embedded ACP runtime ready",
      details: [
        `agent=${agentName}`,
        `command=${agentCommand.agentCommand}`,
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
        `command=${agentCommand.agentCommand}`,
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
  agentName: string,
  agentCommand: ReturnType<typeof normalizeAgentCommandInput>,
  deps: ProbeRuntimeDeps,
): AcpClient {
  const clientOptions = {
    ...agentCommand,
    cwd: options.cwd,
    agentProcessEnv: options.agentProcessEnv,
    mcpServers: typeof options.mcpServers === "function" ? [] : [...(options.mcpServers ?? [])],
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    fs: false,
    terminal: false,
    processLifecycle: options.processLifecycle,
    processLaunchScope: { kind: "runtime-probe" as const, agent: agentName },
    verbose: options.verbose,
  };
  return deps.clientFactory?.(clientOptions) ?? new AcpClient(clientOptions);
}
