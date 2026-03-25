import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InvalidArgumentError, type Command } from "commander";
import { tsImport } from "tsx/esm/api";
import {
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  type GlobalFlags,
} from "../cli/flags.js";
import type { ResolvedAcpxConfig } from "../config.js";
import { type FlowDefinition, FlowRunner } from "../flows.js";

type FlowRunFlags = {
  inputJson?: string;
  inputFile?: string;
  defaultAgent?: string;
};

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
  const module = (await tsImport(pathToFileURL(flowPath).href, import.meta.url)) as {
    default?: unknown;
  };
  if (!module.default || typeof module.default !== "object") {
    throw new Error(`Flow module must export a default flow object: ${flowPath}`);
  }
  return module.default as FlowDefinition;
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
    flowPath: result.state.flowPath,
    status: result.state.status,
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
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`runDir: ${payload.runDir}\n`);
  if (payload.waitingOn) {
    process.stdout.write(`waitingOn: ${payload.waitingOn}\n`);
  }
  process.stdout.write(`${JSON.stringify(payload.outputs, null, 2)}\n`);
}
