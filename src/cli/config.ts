import { createHash } from "node:crypto";
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
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  hasGlobalConfig: boolean;
  hasProjectConfig: boolean;
};

export type LoadResolvedConfigOptions = {
  mcpConfigPath?: string;
};

type ConfigFileLoadResult = {
  config?: ConfigFileShape;
  exists: boolean;
};

type ExplicitMcpConfig = {
  path?: string;
  config?: ConfigFileShape;
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

async function loadExplicitMcpConfig(
  cwd: string,
  configuredPath: string | undefined,
): Promise<ExplicitMcpConfig> {
  if (!configuredPath) {
    return {};
  }

  const resolvedPath = path.resolve(cwd, configuredPath);
  const result = await readConfigFile(resolvedPath);
  if (!result.exists) {
    throw new Error(`MCP config file not found: ${resolvedPath}`);
  }
  return {
    path: resolvedPath,
    config: result.config,
  };
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

export async function loadResolvedConfig(
  cwd: string,
  options: LoadResolvedConfigOptions = {},
): Promise<ResolvedAcpxConfig> {
  const globalPath = defaultGlobalConfigPath();
  const projectPath = projectConfigPath(cwd);

  const [globalResult, projectResult, explicitMcp] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
    loadExplicitMcpConfig(cwd, options.mcpConfigPath),
  ]);

  const globalConfig = globalResult.config;
  const projectConfig = projectResult.config;

  const scalar = resolveScalarConfigValues(projectConfig, projectPath, globalConfig, globalPath);

  const agents = mergeAgents(
    parseAgents(globalConfig?.agents, globalPath),
    parseAgents(projectConfig?.agents, projectPath),
  );
  const auth = mergeAuth(
    parseAuth(globalConfig?.auth, globalPath),
    parseAuth(projectConfig?.auth, projectPath),
  );

  const mcpServers = resolveMcpServers(
    projectConfig,
    projectPath,
    globalConfig,
    globalPath,
    explicitMcp.config,
    explicitMcp.path,
  );
  const disableExec = resolveDisableExec(projectConfig, projectPath, globalConfig, globalPath);

  return {
    ...scalar,
    agents,
    auth,
    disableExec,
    mcpServers,
    globalPath,
    projectPath,
    mcpConfigPath: explicitMcp.path,
    mcpConfigFingerprint: explicitMcp.path
      ? createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex")
      : undefined,
    hasGlobalConfig: globalResult.exists,
    hasProjectConfig: projectResult.exists,
  };
}

function resolveScalarConfigValues(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): Pick<
  ResolvedAcpxConfig,
  | "defaultAgent"
  | "defaultPermissions"
  | "nonInteractivePermissions"
  | "authPolicy"
  | "ttlMs"
  | "timeoutMs"
  | "queueMaxDepth"
  | "format"
> {
  return {
    defaultAgent: resolveDefaultAgent(projectConfig, projectPath, globalConfig, globalPath),
    defaultPermissions: resolveDefaultPermissions(
      projectConfig,
      projectPath,
      globalConfig,
      globalPath,
    ),
    nonInteractivePermissions: resolveNonInteractivePermissions(
      projectConfig,
      projectPath,
      globalConfig,
      globalPath,
    ),
    authPolicy: resolveAuthPolicy(projectConfig, projectPath, globalConfig, globalPath),
    ttlMs: resolveTtlMs(projectConfig, projectPath, globalConfig, globalPath),
    timeoutMs: resolveTimeoutMs(projectConfig, projectPath, globalConfig, globalPath),
    queueMaxDepth: resolveQueueMaxDepth(projectConfig, projectPath, globalConfig, globalPath),
    format: resolveFormat(projectConfig, projectPath, globalConfig, globalPath),
  };
}

function resolveDefaultAgent(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): string {
  return (
    parseDefaultAgent(projectConfig?.defaultAgent, projectPath) ??
    parseDefaultAgent(globalConfig?.defaultAgent, globalPath) ??
    DEFAULT_AGENT_NAME
  );
}

function resolveDefaultPermissions(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): PermissionMode {
  return (
    parsePermissionMode(projectConfig?.defaultPermissions, projectPath) ??
    parsePermissionMode(globalConfig?.defaultPermissions, globalPath) ??
    DEFAULT_PERMISSION_MODE
  );
}

function resolveNonInteractivePermissions(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): NonInteractivePermissionPolicy {
  return (
    parseNonInteractivePermissionPolicy(projectConfig?.nonInteractivePermissions, projectPath) ??
    parseNonInteractivePermissionPolicy(globalConfig?.nonInteractivePermissions, globalPath) ??
    DEFAULT_NON_INTERACTIVE_PERMISSION_POLICY
  );
}

function resolveAuthPolicy(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): AuthPolicy {
  return (
    parseAuthPolicy(projectConfig?.authPolicy, projectPath) ??
    parseAuthPolicy(globalConfig?.authPolicy, globalPath) ??
    DEFAULT_AUTH_POLICY
  );
}

function resolveTtlMs(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): number {
  return (
    parseTtlMs(projectConfig?.ttl, projectPath) ??
    parseTtlMs(globalConfig?.ttl, globalPath) ??
    DEFAULT_TTL_MS
  );
}

function resolveQueueMaxDepth(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): number {
  return (
    parseQueueMaxDepth(projectConfig?.queueMaxDepth, projectPath) ??
    parseQueueMaxDepth(globalConfig?.queueMaxDepth, globalPath) ??
    DEFAULT_QUEUE_MAX_DEPTH
  );
}

function resolveFormat(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): OutputFormat {
  return (
    parseOutputFormat(projectConfig?.format, projectPath) ??
    parseOutputFormat(globalConfig?.format, globalPath) ??
    DEFAULT_OUTPUT_FORMAT
  );
}

function hasConfigKey(config: ConfigFileShape | undefined, key: keyof ConfigFileShape): boolean {
  return config != null && Object.prototype.hasOwnProperty.call(config, key);
}

function resolveTimeoutMs(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): number | undefined {
  if (hasConfigKey(projectConfig, "timeout")) {
    return parseTimeoutMs(projectConfig?.timeout, projectPath);
  }
  if (hasConfigKey(globalConfig, "timeout")) {
    return parseTimeoutMs(globalConfig?.timeout, globalPath);
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveMcpServers(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
  mcpConfig: ConfigFileShape | undefined,
  mcpConfigPath: string | undefined,
): McpServer[] {
  if (mcpConfigPath) {
    return parseMcpServers(mcpConfig?.mcpServers, mcpConfigPath);
  }
  if (hasConfigKey(projectConfig, "mcpServers")) {
    return parseMcpServers(projectConfig?.mcpServers, projectPath);
  }
  if (hasConfigKey(globalConfig, "mcpServers")) {
    return parseMcpServers(globalConfig?.mcpServers, globalPath);
  }
  return [];
}

function resolveDisableExec(
  projectConfig: ConfigFileShape | undefined,
  projectPath: string,
  globalConfig: ConfigFileShape | undefined,
  globalPath: string,
): boolean {
  return (
    parseDisableExec(projectConfig?.disableExec, projectPath) ??
    parseDisableExec(globalConfig?.disableExec, globalPath) ??
    DEFAULT_DISABLE_EXEC
  );
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

  try {
    await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        path: configPath,
        created: false,
      };
    }
    throw error;
  }
  return {
    path: configPath,
    created: true,
  };
}
