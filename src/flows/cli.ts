import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InvalidArgumentError, type Command } from "commander";
import type { ResolvedAcpxConfig } from "../cli/config.js";
import {
  hasExplicitPermissionModeFlag,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  type GlobalFlags,
} from "../cli/flags.js";
import { type FlowDefinition, FlowRunner } from "../flows.js";
import { permissionModeSatisfies } from "../permissions.js";
import type { PermissionMode } from "../types.js";
import { isDefinedFlow } from "./authoring.js";
import { validateFlowDefinition } from "./graph.js";

type FlowRunFlags = {
  inputJson?: string;
  inputFile?: string;
  defaultAgent?: string;
};

const FLOW_RUNTIME_SPECIFIER = "acpx/flows";
const TEXT_MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

export async function handleFlowRun(
  flowFile: string,
  flags: FlowRunFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const outputPolicy = resolveOutputPolicy(globalFlags.format, globalFlags.jsonStrict === true);
  const input = await readFlowInput(flags);
  const flowPath = path.resolve(flowFile);
  const flow = await loadFlowModule(flowPath);
  assertFlowPermissionRequirements(flow, permissionMode, globalFlags);

  const runner = new FlowRunner({
    resolveAgent: (profile?: string) => {
      return resolveAgentInvocation(profile ?? flags.defaultAgent, globalFlags, config);
    },
    permissionMode,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    timeoutMs: globalFlags.timeout,
    ttlMs: globalFlags.ttl,
    verbose: globalFlags.verbose,
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
    },
  });

  const result = await runner.run(flow, input, {
    flowPath,
  });

  printFlowRunResult(result, globalFlags);
}

function assertFlowPermissionRequirements(
  flow: FlowDefinition,
  permissionMode: PermissionMode,
  globalFlags: GlobalFlags,
): void {
  const permissions = flow.permissions;
  if (!permissions) {
    return;
  }

  if (permissions.requireExplicitGrant && !hasExplicitPermissionModeFlag(globalFlags)) {
    throw new InvalidArgumentError(
      buildFlowPermissionFailureMessage(flow, permissions.requiredMode, permissions.reason, true),
    );
  }

  if (!permissionModeSatisfies(permissionMode, permissions.requiredMode)) {
    throw new InvalidArgumentError(
      buildFlowPermissionFailureMessage(flow, permissions.requiredMode, permissions.reason, false),
    );
  }
}

function buildFlowPermissionFailureMessage(
  flow: FlowDefinition,
  requiredMode: PermissionMode,
  reason?: string,
  explicit = false,
): string {
  return [
    explicit
      ? `Flow "${flow.name}" requires an explicit ${requiredMode} grant.`
      : `Flow "${flow.name}" requires permission mode ${requiredMode}.`,
    `Rerun with --${requiredMode}.`,
    ...(reason ? [`Reason: ${reason}`] : []),
  ].join(" ");
}

async function readFlowInput(flags: FlowRunFlags): Promise<unknown> {
  if (flags.inputJson && flags.inputFile) {
    throw new InvalidArgumentError("Use only one of --input-json or --input-file");
  }

  if (flags.inputJson) {
    return parseJsonInput(flags.inputJson, "--input-json");
  }

  if (flags.inputFile) {
    const inputPath = path.resolve(flags.inputFile);
    const payload = await fs.readFile(inputPath, "utf8");
    return parseJsonInput(payload, "--input-file");
  }

  return {};
}

async function loadFlowModule(flowPath: string): Promise<FlowDefinition> {
  const extension = path.extname(flowPath).toLowerCase();
  const prepared = await prepareFlowModuleImport(flowPath, extension);
  try {
    const module = await loadFlowRuntimeModule(prepared.flowUrl, extension);

    const candidate = findFlowDefinition(module);
    if (!candidate) {
      throw new Error(
        `Flow module must export default defineFlow({...}) from "acpx/flows": ${flowPath}`,
      );
    }
    validateFlowDefinition(candidate);
    return candidate;
  } finally {
    await prepared.cleanup?.();
  }
}

async function prepareFlowModuleImport(
  flowPath: string,
  extension: string,
): Promise<{
  flowUrl: string;
  cleanup?: () => Promise<void>;
}> {
  const flowUrl = pathToFileURL(flowPath).href;
  if (!TEXT_MODULE_EXTENSIONS.has(extension)) {
    return { flowUrl };
  }

  const source = await fs.readFile(flowPath, "utf8");
  if (!source.includes(FLOW_RUNTIME_SPECIFIER)) {
    return { flowUrl };
  }

  const runtimeSpecifier = resolveFlowRuntimeImportSpecifier();
  const rewritten = source.replaceAll(
    /(["'])acpx\/flows\1/g,
    (_match, quote: string) => `${quote}${runtimeSpecifier}${quote}`,
  );
  if (rewritten === source) {
    return { flowUrl };
  }

  const tempPath = path.join(path.dirname(flowPath), `.acpx-flow-load-${randomUUID()}${extension}`);
  await fs.writeFile(tempPath, rewritten, "utf8");
  return {
    flowUrl: pathToFileURL(tempPath).href,
    cleanup: async () => {
      await fs.rm(tempPath, { force: true });
    },
  };
}

function resolveFlowRuntimeImportSpecifier(): string {
  const selfPath = fileURLToPath(import.meta.url);

  if (selfPath.endsWith(`${path.sep}src${path.sep}flows${path.sep}cli.ts`)) {
    return new URL("../flows.ts", import.meta.url).href;
  }
  if (selfPath.endsWith(`${path.sep}src${path.sep}flows${path.sep}cli.js`)) {
    return new URL("../flows.js", import.meta.url).href;
  }
  return new URL("./flows.js", import.meta.url).href;
}

async function loadFlowRuntimeModule(
  flowUrl: string,
  extension: string,
): Promise<{
  default?: unknown;
  "module.exports"?: unknown;
}> {
  if (extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts") {
    const { tsImport } = (await import("tsx/esm/api")) as {
      tsImport: (
        specifier: string,
        parentURL: string,
      ) => Promise<{
        default?: unknown;
        "module.exports"?: unknown;
      }>;
    };
    return (await tsImport(flowUrl, import.meta.url)) as {
      default?: unknown;
      "module.exports"?: unknown;
    };
  }

  return (await import(flowUrl)) as {
    default?: unknown;
    "module.exports"?: unknown;
  };
}

function findFlowDefinition(module: {
  default?: unknown;
  "module.exports"?: unknown;
}): FlowDefinition | null {
  const candidates = [
    module.default,
    module["module.exports"],
    getNestedDefault(module.default),
    getNestedDefault(module["module.exports"]),
  ];

  for (const candidate of candidates) {
    if (isDefinedFlow(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getNestedDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("default" in value)) {
    return null;
  }
  return (value as { default?: unknown }).default ?? null;
}

function parseJsonInput(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InvalidArgumentError(
      `${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function printFlowRunResult(
  result: Awaited<ReturnType<FlowRunner["run"]>>,
  globalFlags: GlobalFlags,
): void {
  const payload = {
    action: "flow_run_result",
    runId: result.state.runId,
    flowName: result.state.flowName,
    runTitle: result.state.runTitle,
    flowPath: result.state.flowPath,
    status: result.state.status,
    currentNode: result.state.currentNode,
    currentNodeType: result.state.currentNodeType,
    currentNodeStartedAt: result.state.currentNodeStartedAt,
    lastHeartbeatAt: result.state.lastHeartbeatAt,
    statusDetail: result.state.statusDetail,
    waitingOn: result.state.waitingOn,
    runDir: result.runDir,
    outputs: result.state.outputs,
    sessionBindings: result.state.sessionBindings,
  };

  if (globalFlags.format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${result.state.runId}\n`);
    return;
  }

  process.stdout.write(`runId: ${payload.runId}\n`);
  process.stdout.write(`flow: ${payload.flowName}\n`);
  if (payload.runTitle) {
    process.stdout.write(`title: ${payload.runTitle}\n`);
  }
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`runDir: ${payload.runDir}\n`);
  if (payload.currentNode) {
    process.stdout.write(`currentNode: ${payload.currentNode}\n`);
  }
  if (payload.statusDetail) {
    process.stdout.write(`statusDetail: ${payload.statusDetail}\n`);
  }
  if (payload.waitingOn) {
    process.stdout.write(`waitingOn: ${payload.waitingOn}\n`);
  }
  process.stdout.write(`${JSON.stringify(payload.outputs, null, 2)}\n`);
}
