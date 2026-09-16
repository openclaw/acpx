import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitCommandLine } from "./acp/client-process.js";
import { resolveInstalledExecutable } from "./spawn-command-options.js";

const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.33",
  codex: "^1.1.5",
  claude: "^0.76.0",
  mux: "^0.28.0",
} as const;

type BuiltInAgentPackageSpec = {
  packageName: string;
  packageRange: string;
  preferredBinName: string;
  fallbackCommand: string;
  legacyFallbackCommands?: string[];
};

type BuiltInAgentLaunch = {
  source: "installed" | "package-exec";
  command: string;
  args: string[];
  packageName: string;
  packageRange: string;
  packageVersion?: string;
  binPath?: string;
  npmCliPath?: string;
};

type BuiltInLaunchResolverOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  resolvePackageRoot?: (packageName: string) => string | undefined;
  execPath?: string;
  resolveNpmCliPath?: (execPath: string) => string;
};

type AgentDefinition = {
  name: string;
  argv: string[];
  installedArgv?: string[];
  requiredCommands?: string[];
  package?: Omit<BuiltInAgentPackageSpec, "fallbackCommand">;
  packageExecFallback?: boolean;
};

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  pi: {
    name: "Pi",
    argv: ["npx", `pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`],
    installedArgv: ["pi-acp"],
    requiredCommands: ["pi"],
    package: {
      packageName: "pi-acp",
      packageRange: ACP_ADAPTER_PACKAGE_RANGES.pi,
      preferredBinName: "pi-acp",
    },
  },
  openclaw: { name: "OpenClaw", argv: ["openclaw", "acp"] },
  codex: {
    name: "Codex",
    argv: ["npx", "-y", `@agentclientprotocol/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`],
    installedArgv: ["codex-acp"],
    package: {
      packageName: "@agentclientprotocol/codex-acp",
      packageRange: ACP_ADAPTER_PACKAGE_RANGES.codex,
      preferredBinName: "codex-acp",
      legacyFallbackCommands: [],
    },
    packageExecFallback: true,
  },
  claude: {
    name: "Claude Code",
    argv: [
      "npx",
      "-y",
      `@agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
    ],
    installedArgv: ["claude-agent-acp"],
    package: {
      packageName: "@agentclientprotocol/claude-agent-acp",
      packageRange: ACP_ADAPTER_PACKAGE_RANGES.claude,
      preferredBinName: "claude-agent-acp",
      legacyFallbackCommands: [
        `npm exec @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
      ],
    },
    packageExecFallback: true,
  },
  gemini: { name: "Gemini CLI", argv: ["gemini", "--acp"] },
  cursor: { name: "Cursor", argv: ["cursor-agent", "acp"] },
  copilot: { name: "GitHub Copilot", argv: ["copilot", "--acp", "--stdio"] },
  droid: { name: "Factory Droid", argv: ["droid", "exec", "--output-format", "acp"] },
  "fast-agent": { name: "Fast Agent", argv: ["uvx", "fast-agent-mcp", "acp"] },
  "grok-build": { name: "Grok Build", argv: ["grok", "agent", "stdio"] },
  iflow: { name: "iFlow", argv: ["iflow", "--experimental-acp"] },
  kilocode: {
    name: "Kilo Code",
    argv: ["npx", "-y", "@kilocode/cli", "acp"],
    installedArgv: ["kilo", "acp"],
  },
  kimi: { name: "Kimi Code", argv: ["kimi", "acp"] },
  kiro: { name: "Kiro", argv: ["kiro-cli-chat", "acp"] },
  mcode: { name: "MCode", argv: ["mcode", "acp"] },
  mux: { name: "Mux", argv: ["npx", "-y", `mux@${ACP_ADAPTER_PACKAGE_RANGES.mux}`, "acp"] },
  opencode: {
    name: "OpenCode",
    argv: ["npx", "-y", "opencode-ai", "acp"],
    installedArgv: ["opencode", "acp"],
  },
  pool: { name: "Poolside", argv: ["pool", "acp"] },
  qoder: { name: "Qoder", argv: ["qodercli", "--acp"] },
  qwen: { name: "Qwen Code", argv: ["qwen", "--acp"] },
  trae: { name: "Trae", argv: ["traecli", "acp", "serve"] },
  zeroclaw: { name: "ZeroClaw", argv: ["zeroclaw", "acp"] },
};

export const AGENT_ARGV_REGISTRY: Record<string, string[]> = Object.fromEntries(
  Object.entries(AGENT_DEFINITIONS).map(([id, definition]) => [id, [...definition.argv]]),
);
export const AGENT_REGISTRY: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_DEFINITIONS).map(([id, definition]) => [id, definition.argv.join(" ")]),
);
export const BUILT_IN_AGENT_PACKAGES: Record<string, BuiltInAgentPackageSpec> = Object.fromEntries(
  Object.entries(AGENT_DEFINITIONS).flatMap(([id, definition]) =>
    definition.packageExecFallback && definition.package
      ? [[id, { ...definition.package, fallbackCommand: definition.argv.join(" ") }]]
      : [],
  ),
);

export type AcpAgentInspection = {
  id: string;
  name: string;
  launch:
    | { kind: "installed"; argv: string[] }
    | { kind: "missing"; requirements: Array<{ kind: "command" | "package"; name: string }> };
};

export type AcpAgentInspectionOptions = {
  resolveExecutable?: (command: string) => string | undefined;
  resolvePackageRoot?: (packageName: string) => string | undefined;
};

function isPackageExecution(argv: string[]): boolean {
  const command = path.win32
    .basename(argv[0])
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/, "");
  if (["npx", "uvx", "npm", "pnpm", "bunx"].includes(command)) {
    return true;
  }
  switch (command) {
    case "bun":
      return argv[1] === "x";
    case "uv":
      return argv[1] === "tool" && argv[2] === "run";
    case "node":
      return /(?:npm|npx)-cli\.js$/u.test(argv[1] ?? "");
    default:
      return false;
  }
}

function inspectionDefinition(
  id: string,
  override: string | string[] | undefined,
): AgentDefinition | undefined {
  const definition = Object.hasOwn(AGENT_DEFINITIONS, id) ? AGENT_DEFINITIONS[id] : undefined;
  if (!override) {
    return definition;
  }
  let argv = override;
  if (typeof argv === "string") {
    const parsed = splitCommandLine(argv);
    argv = [parsed.command, ...parsed.args];
  }
  return { name: definition?.name ?? id, argv };
}

function inspectAgent(
  agentId: string,
  override: string | string[] | undefined,
  options: AcpAgentInspectionOptions = {},
): AcpAgentInspection | undefined {
  const id = resolveCanonicalAgentName(agentId);
  const definition = inspectionDefinition(id, override);
  if (!definition) {
    return undefined;
  }
  const argv = definition.installedArgv ?? definition.argv;
  if (isPackageExecution(argv)) {
    return undefined;
  }
  const spec = definition.package
    ? { ...definition.package, fallbackCommand: definition.argv.join(" ") }
    : undefined;
  const launch = inspectLaunch(argv, spec, options);
  return {
    id,
    name: definition.name,
    launch: inspectPrerequisites(launch, definition.requiredCommands ?? [], options),
  };
}

function inspectPrerequisites(
  launch: AcpAgentInspection["launch"],
  requiredCommands: string[],
  options: AcpAgentInspectionOptions,
): AcpAgentInspection["launch"] {
  const resolveExecutable = options.resolveExecutable ?? resolveInstalledExecutable;
  const missingCommands = requiredCommands
    .filter((command) => !resolveExecutable(command))
    .map((name) => ({ kind: "command" as const, name }));
  if (missingCommands.length === 0) {
    return launch;
  }
  return {
    kind: "missing",
    requirements: [...(launch.kind === "missing" ? launch.requirements : []), ...missingCommands],
  };
}

function inspectLaunch(
  argv: string[],
  spec: BuiltInAgentPackageSpec | undefined,
  options: AcpAgentInspectionOptions,
): AcpAgentInspection["launch"] {
  const command = (options.resolveExecutable ?? resolveInstalledExecutable)(argv[0]);
  if (command) {
    return { kind: "installed", argv: [command, ...argv.slice(1)] };
  }
  if (!spec) {
    return { kind: "missing", requirements: [{ kind: "command", name: argv[0] }] };
  }
  const installed = resolveInstalledBuiltInAgentLaunchForSpec(spec, options);
  return installed
    ? { kind: "installed", argv: [installed.command, ...installed.args] }
    : { kind: "missing", requirements: [{ kind: "package", name: spec.packageName }] };
}

const AGENT_ALIASES: Record<string, string> = {
  "factory-droid": "droid",
  factorydroid: "droid",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveCanonicalAgentName(value: string): string {
  const normalized = normalizeAgentName(value);
  return Object.hasOwn(AGENT_ALIASES, normalized) ? AGENT_ALIASES[normalized] : normalized;
}

export function mergeAgentRegistry(overrides?: Record<string, string>): Record<string, string> {
  if (!overrides) {
    return { ...AGENT_REGISTRY };
  }

  const merged = { ...AGENT_REGISTRY };
  for (const [name, command] of Object.entries(overrides)) {
    const normalized = normalizeAgentName(name);
    if (!normalized || !command.trim()) {
      continue;
    }
    merged[normalized] = command.trim();
  }
  return merged;
}

export function resolveAgentCommand(agentName: string, overrides?: Record<string, string>): string {
  const normalized = normalizeAgentName(agentName);
  const registry = mergeAgentRegistry(overrides);
  return registry[normalized] ?? registry[AGENT_ALIASES[normalized] ?? normalized] ?? agentName;
}

export function resolveAgentArgv(agentName: string): string[] | undefined {
  const normalized = normalizeAgentName(agentName);
  const argv =
    AGENT_ARGV_REGISTRY[normalized] ?? AGENT_ARGV_REGISTRY[resolveCanonicalAgentName(agentName)];
  return argv ? [...argv] : undefined;
}

export function findBuiltInAgentPackage(agentCommand: string): BuiltInAgentPackageSpec | undefined {
  const normalized = agentCommand.trim();
  const builtInAgentPackages = Object.values(BUILT_IN_AGENT_PACKAGES);
  return builtInAgentPackages.find(
    (spec) =>
      spec.fallbackCommand === normalized || spec.legacyFallbackCommands?.includes(normalized),
  );
}

function defaultResolvePackageRoot(packageName: string): string {
  const segments = packageName.split("/");
  let cursor = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidateRoot = path.join(cursor, "node_modules", ...segments);
    const manifestPath = path.join(candidateRoot, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          name?: string;
        };
        if (parsed.name === packageName) {
          return candidateRoot;
        }
      } catch {
        // best effort; keep walking upward
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Built-in agent package not found: ${packageName}`);
    }
    cursor = parent;
  }
}

function resolvePackageBin(
  spec: BuiltInAgentPackageSpec,
  manifest: {
    bin?: string | Record<string, string>;
  },
): string | undefined {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }
  if (!manifest.bin || typeof manifest.bin !== "object") {
    return undefined;
  }
  return (
    manifest.bin[spec.preferredBinName] ??
    (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : undefined)
  );
}

function defaultResolveNpmCliPath(execPath: string): string {
  const candidate = path.resolve(
    path.dirname(execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!fs.existsSync(candidate)) {
    throw new Error(`npm CLI not found for execPath: ${execPath}`);
  }
  return candidate;
}

export function resolveInstalledBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  return resolveInstalledBuiltInAgentLaunchForSpec(spec, options);
}

function resolveInstalledBuiltInAgentLaunchForSpec(
  spec: BuiltInAgentPackageSpec,
  options: BuiltInLaunchResolverOptions,
): BuiltInAgentLaunch | undefined {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const resolvePackageRoot = options.resolvePackageRoot ?? defaultResolvePackageRoot;

  try {
    const resolved = resolveInstalledBuiltInAgentPackage(spec, {
      readFileSync,
      existsSync,
      resolvePackageRoot,
    });
    if (!resolved) {
      return undefined;
    }

    return {
      source: "installed",
      command: process.execPath,
      args: [resolved.binPath],
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      packageVersion: resolved.packageVersion,
      binPath: resolved.binPath,
    };
  } catch {
    return undefined;
  }
}

function resolveInstalledBuiltInAgentPackage(
  spec: BuiltInAgentPackageSpec,
  options: Required<
    Pick<BuiltInLaunchResolverOptions, "readFileSync" | "existsSync" | "resolvePackageRoot">
  >,
): { packageVersion?: string; binPath: string } | undefined {
  const packageRoot = options.resolvePackageRoot(spec.packageName);
  if (!packageRoot) {
    return undefined;
  }
  const manifest = JSON.parse(
    options.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (manifest.name !== spec.packageName) {
    return undefined;
  }

  const relativeBinPath = resolvePackageBin(spec, manifest);
  if (!relativeBinPath) {
    return undefined;
  }

  const binPath = path.resolve(packageRoot, relativeBinPath);
  return options.existsSync(binPath) ? { packageVersion: manifest.version, binPath } : undefined;
}

export function resolvePackageExecBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const execPath = options.execPath ?? process.execPath;
  const resolveNpmCliPath = options.resolveNpmCliPath ?? defaultResolveNpmCliPath;

  try {
    const npmCliPath = resolveNpmCliPath(execPath);
    if (!existsSync(npmCliPath)) {
      return undefined;
    }

    return {
      source: "package-exec",
      command: execPath,
      args: [
        npmCliPath,
        "exec",
        "--yes",
        `--package=${spec.packageName}@${spec.packageRange}`,
        "--",
        spec.preferredBinName,
      ],
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      npmCliPath,
    };
  } catch {
    return undefined;
  }
}

export function resolveBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  return (
    resolveInstalledBuiltInAgentLaunch(agentCommand, options) ??
    resolvePackageExecBuiltInAgentLaunch(agentCommand, options)
  );
}

export function listBuiltInAgents(overrides?: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(AGENT_REGISTRY), ...Object.keys(overrides ?? {})])];
}

export interface AcpAgentRegistry {
  resolve(agentName: string): string | string[];
  list(): string[];
}

export type AcpInspectableAgentRegistry = AcpAgentRegistry & {
  inspect(agentId: string): AcpAgentInspection | undefined;
};

export function createAgentRegistry(
  params?: {
    overrides?: Record<string, string | string[]>;
  } & AcpAgentInspectionOptions,
): AcpInspectableAgentRegistry {
  const overrides = normalizeRegistryOverrides(params?.overrides);
  return {
    resolve(agentName: string) {
      const normalizedAgentName = normalizeAgentName(agentName);
      const override =
        overrides[normalizedAgentName] ?? overrides[resolveCanonicalAgentName(agentName)];
      return override ?? resolveAgentArgv(agentName) ?? resolveAgentCommand(agentName);
    },
    list() {
      return listBuiltInAgents(overrides);
    },
    inspect(agentId) {
      const normalized = normalizeAgentName(agentId);
      const canonical = resolveCanonicalAgentName(agentId);
      const override = Object.hasOwn(overrides, normalized)
        ? overrides[normalized]
        : Object.hasOwn(overrides, canonical)
          ? overrides[canonical]
          : undefined;
      return inspectAgent(agentId, override, params);
    },
  };
}

function normalizeRegistryOverrides(
  values: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    const normalizedName = normalizeAgentName(name);
    if (!normalizedName) {
      continue;
    }
    const normalizedValue = normalizeRegistryOverride(value);
    if (normalizedValue) {
      normalized[normalizedName] = normalizedValue;
    }
  }
  return normalized;
}

function normalizeRegistryOverride(value: string | string[]): string | string[] | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return value.length > 0 && value[0]?.length ? [...value] : undefined;
}
