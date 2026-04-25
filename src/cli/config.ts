import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_NAME, normalizeAgentName } from "../agent-registry.js";
import { parseMcpServers } from "../mcp-servers.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputFormat,
  PermissionMode,
} from "../types.js";

type ConfigAgentEntry = {
  command: string;
  args?: string[];
};

type ConfigFileShape = {
  defaultAgent?: unknown;
  defaultPermissions?: unknown;
  nonInteractivePermissions?: unknown;
  authPolicy?: unknown;
  ttl?: unknown;
  timeout?: unknown;
  queueMaxDepth?: unknown;
  format?: unknown;
  agents?: unknown;
  auth?: unknown;
  disableExec?: unknown;
  mcpServers?: unknown;
};

export type ResolvedAcpxConfig = {
  defaultAgent: string;
  defaultPermissions: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissionPolicy;
  authPolicy: AuthPolicy;
  ttlMs: number;
  timeoutMs?: number;
  queueMaxDepth: number;
  format: OutputFormat;
  agents: Record<string, string>;
  auth: Record<string, string>;
  disableExec: boolean;
  mcpServers: McpServer[];
  globalPath: string;
  projectPath: string;
  hasGlobalConfig: boolean;
  hasProjectConfig: boolean;
};

type ConfigFileLoadResult = {
  config?: ConfigFileShape;
  exists: boolean;
};

const DEFAULT_TIMEOUT_MS = undefined;
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-reads";
const DEFAULT_NON_INTERACTIVE_PERMISSION_POLICY: NonInteractivePermissionPolicy = "deny";
const DEFAULT_AUTH_POLICY: AuthPolicy = "skip";
const DEFAULT_OUTPUT_FORMAT: OutputFormat = "text";
const DEFAULT_QUEUE_MAX_DEPTH = 16;
const DEFAULT_DISABLE_EXEC = false;
const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  "approve-all",
  "approve-reads",
  "deny-all",
]);
const VALID_NON_INTERACTIVE_PERMISSION_POLICIES = new Set<NonInteractivePermissionPolicy>([
  "deny",
  "fail",
]);
const VALID_AUTH_POLICIES = new Set<AuthPolicy>(["skip", "fail"]);
const VALID_OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "quiet"]);

function defaultGlobalConfigPath(): string {
  return path.join(os.homedir(), ".acpx", "config.json");
}

function projectConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".acpxrc.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTtlMs(value: unknown, sourcePath: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid config ttl in ${sourcePath}: expected non-negative seconds`);
  }
  return Math.round(value * 1_000);
}

function parseTimeoutMs(value: unknown, sourcePath: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config timeout in ${sourcePath}: expected positive seconds or null`);
  }
  return Math.round(value * 1_000);
}

function parseQueueMaxDepth(value: unknown, sourcePath: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid config queueMaxDepth in ${sourcePath}: expected positive integer`);
  }
  return value as number;
}

function parsePermissionMode(value: unknown, sourcePath: string): PermissionMode | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !VALID_PERMISSION_MODES.has(value as PermissionMode)) {
    throw new Error(
      `Invalid config defaultPermissions in ${sourcePath}: expected approve-all, approve-reads, or deny-all`,
    );
  }
  return value as PermissionMode;
}

function parseNonInteractivePermissionPolicy(
  value: unknown,
  sourcePath: string,
): NonInteractivePermissionPolicy | undefined {
  if (value == null) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !VALID_NON_INTERACTIVE_PERMISSION_POLICIES.has(value as NonInteractivePermissionPolicy)
  ) {
    throw new Error(
      `Invalid config nonInteractivePermissions in ${sourcePath}: expected deny or fail`,
    );
  }
  return value as NonInteractivePermissionPolicy;
}

function parseAuthPolicy(value: unknown, sourcePath: string): AuthPolicy | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !VALID_AUTH_POLICIES.has(value as AuthPolicy)) {
    throw new Error(`Invalid config authPolicy in ${sourcePath}: expected skip or fail`);
  }
  return value as AuthPolicy;
}

function parseOutputFormat(value: unknown, sourcePath: string): OutputFormat | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !VALID_OUTPUT_FORMATS.has(value as OutputFormat)) {
    throw new Error(`Invalid config format in ${sourcePath}: expected text, json, or quiet`);
  }
  return value as OutputFormat;
}

function parseDefaultAgent(value: unknown, sourcePath: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid config defaultAgent in ${sourcePath}: expected non-empty string`);
  }
  return normalizeAgentName(value);
}

function parseAgents(value: unknown, sourcePath: string): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`Invalid config agents in ${sourcePath}: expected object`);
  }

  const parsed: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isObject(raw)) {
      throw new Error(
        `Invalid config agents.${name} in ${sourcePath}: expected object with command`,
      );
    }
    const command = raw.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(
        `Invalid config agents.${name}.command in ${sourcePath}: expected non-empty string`,
      );
    }
    const args = parseAgentArgs(raw.args, name, sourcePath);
    parsed[normalizeAgentName(name)] =
      args.length > 0 ? `${command.trim()} ${args.map(quoteCommandArg).join(" ")}` : command.trim();
  }

  return parsed;
}

function parseAgentArgs(value: unknown, agentName: string, sourcePath: string): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid config agents.${agentName}.args in ${sourcePath}: expected array of strings`,
    );
  }
  return value.map((arg, index) => {
    if (typeof arg !== "string") {
      throw new Error(
        `Invalid config agents.${agentName}.args[${index}] in ${sourcePath}: expected string`,
      );
    }
    return arg;
  });
}

function quoteCommandArg(value: string): string {
  return JSON.stringify(value);
}

function parseAuth(value: unknown, sourcePath: string): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`Invalid config auth in ${sourcePath}: expected object`);
  }

  const parsed: Record<string, string> = {};
  for (const [methodId, rawCredential] of Object.entries(value)) {
    if (typeof rawCredential !== "string" || rawCredential.trim().length === 0) {
      throw new Error(
        `Invalid config auth.${methodId} in ${sourcePath}: expected non-empty string`,
      );
    }
    parsed[methodId] = rawCredential;
  }
  return parsed;
}

function parseDisableExec(value: unknown, sourcePath: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Invalid config disableExec in ${sourcePath}: expected boolean`);
  }
  return value;
}

async function readConfigFile(filePath: string): Promise<ConfigFileLoadResult> {
  try {
    const payload = await fs.readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in ${filePath}: ${reason}`, {
        cause: error,
      });
    }

    if (!isObject(parsed)) {
      throw new Error(`Invalid config in ${filePath}: expected top-level JSON object`);
    }
    return {
      config: parsed as ConfigFileShape,
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

function mergeAgents(
  globalAgents: Record<string, string> | undefined,
  projectAgents: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...globalAgents,
    ...projectAgents,
  };
}

function mergeAuth(
  globalAuth: Record<string, string> | undefined,
  projectAuth: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...globalAuth,
    ...projectAuth,
  };
}

export async function loadResolvedConfig(cwd: string): Promise<ResolvedAcpxConfig> {
  const globalPath = defaultGlobalConfigPath();
  const projectPath = projectConfigPath(cwd);

  const [globalResult, projectResult] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  const globalConfig = globalResult.config;
  const projectConfig = projectResult.config;

  const defaultAgent =
    parseDefaultAgent(projectConfig?.defaultAgent, projectPath) ??
    parseDefaultAgent(globalConfig?.defaultAgent, globalPath) ??
    DEFAULT_AGENT_NAME;

  const defaultPermissions =
    parsePermissionMode(projectConfig?.defaultPermissions, projectPath) ??
    parsePermissionMode(globalConfig?.defaultPermissions, globalPath) ??
    DEFAULT_PERMISSION_MODE;

  const nonInteractivePermissions =
    parseNonInteractivePermissionPolicy(projectConfig?.nonInteractivePermissions, projectPath) ??
    parseNonInteractivePermissionPolicy(globalConfig?.nonInteractivePermissions, globalPath) ??
    DEFAULT_NON_INTERACTIVE_PERMISSION_POLICY;

  const authPolicy =
    parseAuthPolicy(projectConfig?.authPolicy, projectPath) ??
    parseAuthPolicy(globalConfig?.authPolicy, globalPath) ??
    DEFAULT_AUTH_POLICY;

  const ttlMs =
    parseTtlMs(projectConfig?.ttl, projectPath) ??
    parseTtlMs(globalConfig?.ttl, globalPath) ??
    DEFAULT_TTL_MS;

  const timeoutConfiguredInProject =
    projectConfig != null && Object.prototype.hasOwnProperty.call(projectConfig, "timeout");
  const timeoutConfiguredInGlobal =
    globalConfig != null && Object.prototype.hasOwnProperty.call(globalConfig, "timeout");
  let timeoutMs: number | undefined = DEFAULT_TIMEOUT_MS;
  if (timeoutConfiguredInProject) {
    timeoutMs = parseTimeoutMs(projectConfig?.timeout, projectPath);
  } else if (timeoutConfiguredInGlobal) {
    timeoutMs = parseTimeoutMs(globalConfig?.timeout, globalPath);
  }

  const format =
    parseOutputFormat(projectConfig?.format, projectPath) ??
    parseOutputFormat(globalConfig?.format, globalPath) ??
    DEFAULT_OUTPUT_FORMAT;

  const queueMaxDepth =
    parseQueueMaxDepth(projectConfig?.queueMaxDepth, projectPath) ??
    parseQueueMaxDepth(globalConfig?.queueMaxDepth, globalPath) ??
    DEFAULT_QUEUE_MAX_DEPTH;

  const agents = mergeAgents(
    parseAgents(globalConfig?.agents, globalPath),
    parseAgents(projectConfig?.agents, projectPath),
  );
  const auth = mergeAuth(
    parseAuth(globalConfig?.auth, globalPath),
    parseAuth(projectConfig?.auth, projectPath),
  );

  const mcpServersConfiguredInProject =
    projectConfig != null && Object.prototype.hasOwnProperty.call(projectConfig, "mcpServers");
  const mcpServersConfiguredInGlobal =
    globalConfig != null && Object.prototype.hasOwnProperty.call(globalConfig, "mcpServers");
  let mcpServers: McpServer[] = [];
  if (mcpServersConfiguredInProject) {
    mcpServers = parseMcpServers(projectConfig?.mcpServers, projectPath);
  } else if (mcpServersConfiguredInGlobal) {
    mcpServers = parseMcpServers(globalConfig?.mcpServers, globalPath);
  }

  const disableExec =
    parseDisableExec(projectConfig?.disableExec, projectPath) ??
    parseDisableExec(globalConfig?.disableExec, globalPath) ??
    DEFAULT_DISABLE_EXEC;

  return {
    defaultAgent,
    defaultPermissions,
    nonInteractivePermissions,
    authPolicy,
    ttlMs,
    timeoutMs,
    queueMaxDepth,
    format,
    agents,
    auth,
    disableExec,
    mcpServers,
    globalPath,
    projectPath,
    hasGlobalConfig: globalResult.exists,
    hasProjectConfig: projectResult.exists,
  };
}

export function toConfigDisplay(config: ResolvedAcpxConfig): {
  defaultAgent: string;
  defaultPermissions: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissionPolicy;
  authPolicy: AuthPolicy;
  ttl: number;
  timeout: number | null;
  queueMaxDepth: number;
  format: OutputFormat;
  agents: Record<string, ConfigAgentEntry>;
  authMethods: string[];
  disableExec: boolean;
} {
  const agents: Record<string, ConfigAgentEntry> = {};
  for (const [name, command] of Object.entries(config.agents)) {
    agents[name] = { command };
  }

  return {
    defaultAgent: config.defaultAgent,
    defaultPermissions: config.defaultPermissions,
    nonInteractivePermissions: config.nonInteractivePermissions,
    authPolicy: config.authPolicy,
    ttl: Math.round(config.ttlMs / 1_000),
    timeout: config.timeoutMs == null ? null : config.timeoutMs / 1_000,
    queueMaxDepth: config.queueMaxDepth,
    format: config.format,
    agents,
    authMethods: Object.keys(config.auth).toSorted(),
    disableExec: config.disableExec,
  };
}

export async function initGlobalConfigFile(): Promise<{
  path: string;
  created: boolean;
}> {
  const configPath = defaultGlobalConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  try {
    await fs.access(configPath);
    return {
      path: configPath,
      created: false,
    };
  } catch {
    // file does not exist yet
  }

  const payload = {
    defaultAgent: DEFAULT_AGENT_NAME,
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttl: 300,
    timeout: null,
    queueMaxDepth: DEFAULT_QUEUE_MAX_DEPTH,
    format: "text",
    agents: {},
    auth: {},
  };

  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    path: configPath,
    created: true,
  };
}
