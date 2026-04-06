import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.22",
  codex: "^0.11.1",
  claude: "^0.25.0",
} as const;

type BuiltInAgentPackageSpec = {
  packageName: string;
  packageRange: string;
  preferredBinName: string;
  fallbackCommand: string;
};

type BuiltInAgentLaunch = {
  command: string;
  args: string[];
  packageName: string;
  packageVersion?: string;
  binPath: string;
};

type BuiltInLaunchResolverOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  resolvePackageRoot?: (packageName: string) => string;
};

export const AGENT_REGISTRY: Record<string, string> = {
  pi: `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`,
  openclaw: "openclaw acp",
  codex: `npx @zed-industries/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`,
  claude: `npx -y @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  droid: "droid exec --output-format acp",
  iflow: "iflow --experimental-acp",
  kilocode: "npx -y @kilocode/cli acp",
  kimi: "kimi acp",
  kiro: "kiro-cli-chat acp",
  opencode: "npx -y opencode-ai acp",
  qoder: "qodercli --acp",
  qwen: "qwen --acp",
  trae: "traecli acp serve",
};

export const BUILT_IN_AGENT_PACKAGES = {
  codex: {
    packageName: "@zed-industries/codex-acp",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.codex,
    preferredBinName: "codex-acp",
    fallbackCommand: AGENT_REGISTRY.codex,
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    packageRange: ACP_ADAPTER_PACKAGE_RANGES.claude,
    preferredBinName: "claude-agent-acp",
    fallbackCommand: AGENT_REGISTRY.claude,
  },
} as const satisfies Record<string, BuiltInAgentPackageSpec>;

const AGENT_ALIASES: Record<string, string> = {
  "factory-droid": "droid",
  factorydroid: "droid",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
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

export function findBuiltInAgentPackage(agentCommand: string): BuiltInAgentPackageSpec | undefined {
  const normalized = agentCommand.trim();
  return Object.values(BUILT_IN_AGENT_PACKAGES).find((spec) => spec.fallbackCommand === normalized);
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

export function resolveInstalledBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const resolvePackageRoot = options.resolvePackageRoot ?? defaultResolvePackageRoot;

  try {
    const packageRoot = resolvePackageRoot(spec.packageName);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
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
    if (!existsSync(binPath)) {
      return undefined;
    }

    return {
      command: process.execPath,
      args: [binPath],
      packageName: spec.packageName,
      packageVersion: manifest.version,
      binPath,
    };
  } catch {
    return undefined;
  }
}

export function listBuiltInAgents(overrides?: Record<string, string>): string[] {
  return Object.keys(mergeAgentRegistry(overrides));
}
