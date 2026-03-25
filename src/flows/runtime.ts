import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOutputFormatter } from "../output.js";
import { promptToDisplayText, textPrompt } from "../prompt-content.js";
import { resolveSessionRecord } from "../session-persistence.js";
import { createSession, runOnce, sendSession, type SessionAgentOptions } from "../session.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
} from "../types.js";

type MaybePromise<T> = T | Promise<T>;

export type FlowNodeContext<TInput = unknown> = {
  input: TInput;
  outputs: Record<string, unknown>;
  state: FlowRunState;
  services: Record<string, unknown>;
};

export type FlowEdge =
  | {
      from: string;
      to: string;
    }
  | {
      from: string;
      switch: {
        on: string;
        cases: Record<string, string>;
      };
    };

export type AcpNodeDefinition = {
  kind: "acp";
  profile?: string;
  session?: {
    handle?: string;
    isolated?: boolean;
  };
  prompt: (context: FlowNodeContext) => MaybePromise<PromptInput | string>;
  parse?: (text: string, context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ComputeNodeDefinition = {
  kind: "compute";
  run: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type ActionNodeDefinition = {
  kind: "action";
  run: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type CheckpointNodeDefinition = {
  kind: "checkpoint";
  summary?: string;
  run?: (context: FlowNodeContext) => MaybePromise<unknown>;
};

export type FlowNodeDefinition =
  | AcpNodeDefinition
  | ComputeNodeDefinition
  | ActionNodeDefinition
  | CheckpointNodeDefinition;

export type FlowDefinition = {
  name: string;
  startAt: string;
  nodes: Record<string, FlowNodeDefinition>;
  edges: FlowEdge[];
};

export type FlowStepRecord = {
  nodeId: string;
  kind: FlowNodeDefinition["kind"];
  startedAt: string;
  finishedAt: string;
  promptText: string | null;
  rawText: string | null;
  output: unknown;
  session: FlowSessionBinding | null;
  agent: {
    agentName: string;
    agentCommand: string;
    cwd: string;
  } | null;
};

export type FlowSessionBinding = {
  key: string;
  handle: string;
  name: string;
  profile?: string;
  agentName: string;
  agentCommand: string;
  cwd: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
};

export type FlowRunState = {
  runId: string;
  flowName: string;
  flowPath?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: "running" | "waiting" | "completed" | "failed";
  input: unknown;
  outputs: Record<string, unknown>;
  steps: FlowStepRecord[];
  sessionBindings: Record<string, FlowSessionBinding>;
  waitingOn?: string;
  error?: string;
};

export type FlowRunResult = {
  runDir: string;
  state: FlowRunState;
};

type MemoryWritable = {
  write(chunk: string): void;
};

export type FlowRunnerOptions = {
  resolveAgent: (profile?: string) => {
    agentName: string;
    agentCommand: string;
    cwd: string;
  };
  permissionMode: PermissionMode;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  ttlMs?: number;
  verbose?: boolean;
  suppressSdkConsoleErrors?: boolean;
  sessionOptions?: SessionAgentOptions;
  services?: Record<string, unknown>;
  outputRoot?: string;
};

export function defineFlow<TFlow extends FlowDefinition>(definition: TFlow): TFlow {
  return definition;
}

export function acp(definition: Omit<AcpNodeDefinition, "kind">): AcpNodeDefinition {
  return {
    kind: "acp",
    ...definition,
  };
}

export function compute(definition: Omit<ComputeNodeDefinition, "kind">): ComputeNodeDefinition {
  return {
    kind: "compute",
    ...definition,
  };
}

export function action(definition: Omit<ActionNodeDefinition, "kind">): ActionNodeDefinition {
  return {
    kind: "action",
    ...definition,
  };
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "kind"> = {},
): CheckpointNodeDefinition {
  return {
    kind: "checkpoint",
    ...definition,
  };
}

export function flowRunsBaseDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "flows", "runs");
}

export class FlowRunner {
  private readonly resolveAgent;
  private readonly permissionMode;
  private readonly mcpServers?;
  private readonly nonInteractivePermissions?;
  private readonly authCredentials?;
  private readonly authPolicy?;
  private readonly timeoutMs?;
  private readonly ttlMs?;
  private readonly verbose?;
  private readonly suppressSdkConsoleErrors?;
  private readonly sessionOptions?;
  private readonly services;
  private readonly outputRoot;

  constructor(options: FlowRunnerOptions) {
    this.resolveAgent = options.resolveAgent;
    this.permissionMode = options.permissionMode;
    this.mcpServers = options.mcpServers;
    this.nonInteractivePermissions = options.nonInteractivePermissions;
    this.authCredentials = options.authCredentials;
    this.authPolicy = options.authPolicy;
    this.timeoutMs = options.timeoutMs;
    this.ttlMs = options.ttlMs;
    this.verbose = options.verbose;
    this.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    this.sessionOptions = options.sessionOptions;
    this.services = options.services ?? {};
    this.outputRoot = options.outputRoot ?? flowRunsBaseDir();
  }

  async run(
    flow: FlowDefinition,
    input: unknown,
    options: { flowPath?: string } = {},
  ): Promise<FlowRunResult> {
    validateFlowDefinition(flow);

    const runId = createRunId(flow.name);
    const runDir = path.join(this.outputRoot, runId);
    const state: FlowRunState = {
      runId,
      flowName: flow.name,
      flowPath: options.flowPath,
      startedAt: isoNow(),
      updatedAt: isoNow(),
      status: "running",
      input,
      outputs: {},
      steps: [],
      sessionBindings: {},
    };

    await fs.mkdir(runDir, { recursive: true });
    await this.persist(runDir, state, {
      type: "run_started",
      flowName: flow.name,
      flowPath: options.flowPath,
    });

    let current: string | null = flow.startAt;

    try {
      while (current) {
        const node = flow.nodes[current];
        if (!node) {
          throw new Error(`Unknown flow node: ${current}`);
        }

        const startedAt = isoNow();
        const context = this.makeContext(state, input);
        let output: unknown;
        let promptText: string | null = null;
        let rawText: string | null = null;
        let sessionInfo: FlowSessionBinding | null = null;
        let agentInfo: ReturnType<FlowRunnerOptions["resolveAgent"]> | null = null;

        switch (node.kind) {
          case "compute": {
            output = await node.run(context);
            break;
          }
          case "action": {
            output = await node.run(context);
            break;
          }
          case "checkpoint": {
            output =
              typeof node.run === "function"
                ? await node.run(context)
                : {
                    checkpoint: current,
                    summary: node.summary ?? current,
                  };
            state.outputs[current] = output;
            state.waitingOn = current;
            state.updatedAt = isoNow();
            state.status = "waiting";
            state.steps.push({
              nodeId: current,
              kind: node.kind,
              startedAt,
              finishedAt: isoNow(),
              promptText,
              rawText,
              output,
              session: null,
              agent: null,
            });
            await this.persist(runDir, state, {
              type: "checkpoint_entered",
              nodeId: current,
              output,
            });
            return {
              runDir,
              state,
            };
          }
          case "acp": {
            agentInfo = this.resolveAgent(node.profile);
            const prompt = normalizePromptInput(await node.prompt(context));
            promptText = promptToDisplayText(prompt);
            if (node.session?.isolated) {
              rawText = await this.runIsolatedPrompt(agentInfo, prompt);
            } else {
              sessionInfo = await this.ensureSessionBinding(state, flow, node, agentInfo);
              rawText = await this.runPersistentPrompt(sessionInfo, prompt);
              sessionInfo = await this.refreshSessionBinding(sessionInfo);
              state.sessionBindings[sessionInfo.key] = sessionInfo;
            }
            output = node.parse ? await node.parse(rawText, context) : rawText;
            break;
          }
          default: {
            const exhaustive: never = node;
            throw new Error(`Unsupported flow node: ${String(exhaustive)}`);
          }
        }

        state.outputs[current] = output;
        state.updatedAt = isoNow();
        state.steps.push({
          nodeId: current,
          kind: node.kind,
          startedAt,
          finishedAt: isoNow(),
          promptText,
          rawText,
          output,
          session: sessionInfo,
          agent: agentInfo,
        });

        await this.persist(runDir, state, {
          type: "node_completed",
          nodeId: current,
          output,
        });

        current = resolveNext(flow.edges, current, output);
      }

      state.status = "completed";
      state.finishedAt = isoNow();
      state.updatedAt = state.finishedAt;
      await this.persist(runDir, state, { type: "run_completed" });
      return {
        runDir,
        state,
      };
    } catch (error) {
      state.status = "failed";
      state.updatedAt = isoNow();
      state.finishedAt = state.updatedAt;
      state.error = error instanceof Error ? error.message : String(error);
      await this.persist(runDir, state, {
        type: "run_failed",
        error: state.error,
      });
      throw error;
    }
  }

  private makeContext(state: FlowRunState, input: unknown): FlowNodeContext {
    return {
      input,
      outputs: state.outputs,
      state,
      services: this.services,
    };
  }

  private async ensureSessionBinding(
    state: FlowRunState,
    flow: FlowDefinition,
    node: AcpNodeDefinition,
    agent: ReturnType<FlowRunnerOptions["resolveAgent"]>,
  ): Promise<FlowSessionBinding> {
    const handle = node.session?.handle ?? "main";
    const key = `${agent.agentCommand}::${handle}`;
    const existing = state.sessionBindings[key];
    if (existing) {
      return existing;
    }

    const name = `${flow.name}-${handle}-${state.runId.slice(-8)}`;
    const created = await createSession({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      name,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      timeoutMs: this.timeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });

    const binding: FlowSessionBinding = {
      key,
      handle,
      name,
      profile: node.profile,
      agentName: agent.agentName,
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      acpxRecordId: created.acpxRecordId,
      acpSessionId: created.acpSessionId,
      agentSessionId: created.agentSessionId,
    };
    state.sessionBindings[key] = binding;
    return binding;
  }

  private async refreshSessionBinding(binding: FlowSessionBinding): Promise<FlowSessionBinding> {
    const record = await resolveSessionRecord(binding.acpxRecordId);
    return {
      ...binding,
      acpSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
    };
  }

  private async runPersistentPrompt(
    binding: FlowSessionBinding,
    prompt: PromptInput,
  ): Promise<string> {
    const capture = createQuietCaptureOutput();
    await sendSession({
      sessionId: binding.acpxRecordId,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      outputFormatter: capture.formatter,
      suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
      timeoutMs: this.timeoutMs,
      ttlMs: this.ttlMs,
      verbose: this.verbose,
      waitForCompletion: true,
    });
    return capture.read();
  }

  private async runIsolatedPrompt(
    agent: ReturnType<FlowRunnerOptions["resolveAgent"]>,
    prompt: PromptInput,
  ): Promise<string> {
    const capture = createQuietCaptureOutput();
    await runOnce({
      agentCommand: agent.agentCommand,
      cwd: agent.cwd,
      prompt,
      mcpServers: this.mcpServers,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      authCredentials: this.authCredentials,
      authPolicy: this.authPolicy,
      outputFormatter: capture.formatter,
      suppressSdkConsoleErrors: this.suppressSdkConsoleErrors,
      timeoutMs: this.timeoutMs,
      verbose: this.verbose,
      sessionOptions: this.sessionOptions,
    });
    return capture.read();
  }

  private async persist(
    runDir: string,
    state: FlowRunState,
    event: Record<string, unknown>,
  ): Promise<void> {
    state.updatedAt = isoNow();
    const runPath = path.join(runDir, "run.json");
    const tempPath = `${runPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(state, null, 2);
    await fs.writeFile(tempPath, `${payload}\n`, "utf8");
    await fs.rename(tempPath, runPath);
    await fs.appendFile(
      path.join(runDir, "events.ndjson"),
      `${JSON.stringify({ at: isoNow(), ...event })}\n`,
      "utf8",
    );
  }
}

function validateFlowDefinition(flow: FlowDefinition): void {
  if (!flow.name.trim()) {
    throw new Error("Flow name must not be empty");
  }
  if (!flow.nodes[flow.startAt]) {
    throw new Error(`Flow start node is missing: ${flow.startAt}`);
  }

  for (const edge of flow.edges) {
    if (!flow.nodes[edge.from]) {
      throw new Error(`Flow edge references unknown from-node: ${edge.from}`);
    }
    if ("to" in edge) {
      if (!flow.nodes[edge.to]) {
        throw new Error(`Flow edge references unknown to-node: ${edge.to}`);
      }
      continue;
    }
    for (const target of Object.values(edge.switch.cases)) {
      if (!flow.nodes[target]) {
        throw new Error(`Flow switch references unknown to-node: ${target}`);
      }
    }
  }
}

function normalizePromptInput(prompt: PromptInput | string): PromptInput {
  return typeof prompt === "string" ? textPrompt(prompt) : prompt;
}

function resolveNext(edges: FlowEdge[], from: string, output: unknown): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge) {
    return null;
  }

  if ("to" in edge) {
    return edge.to;
  }

  const value = getByPath(output, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
}

function getByPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new Error(`Unsupported JSON path: ${jsonPath}`);
  }

  return jsonPath
    .slice(2)
    .split(".")
    .reduce<unknown>((current, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}

function createQuietCaptureOutput(): {
  formatter: ReturnType<typeof createOutputFormatter>;
  read: () => string;
} {
  const chunks: string[] = [];
  const stdout: MemoryWritable = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };

  return {
    formatter: createOutputFormatter("quiet", {
      stdout,
    }),
    read: () => chunks.join("").trim(),
  };
}

function createRunId(flowName: string): string {
  const stamp = isoNow().replaceAll(":", "").replaceAll(".", "");
  const slug = flowName
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

function isoNow(): string {
  return new Date().toISOString();
}
