/**
 * Which parent environment names agent children, command probes and ACP terminals inherit.
 * Both lists are opt-in; with neither set, children inherit the whole parent environment.
 */
export type InheritedEnvPolicy = {
  /** When set, inherit only process essentials, these names and `ACPX_AUTH_*` grants. */
  allow?: readonly string[];
  /** Names removed after `allow` is applied. `ACPX_AUTH_*` grants are never removed. */
  block?: readonly string[];
};

const AUTH_GRANT_PREFIX = "ACPX_AUTH_";

// Process essentials kept under an allowlist: executable lookup, account and home
// resolution, temp directories, locale and time zone, and per-user base directories.
// Based on the set OpenClaw keeps for native diagnostic children, plus SHELL and XDG_*.
const POSIX_ESSENTIAL_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
];
// Windows bootstrap, DLL resolution, shell lookup and native profile directories.
const WINDOWS_ESSENTIAL_NAMES = [
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
];
// Locale categories (LC_*) and XDG base directories (XDG_*) are kept by prefix.
const ESSENTIAL_PREFIXES = ["LC_", "XDG_"];

/** Environment name as compared on this platform: Windows names are case-insensitive. */
function envNameKey(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

function essentialNames(): string[] {
  return process.platform === "win32"
    ? [...POSIX_ESSENTIAL_NAMES, ...WINDOWS_ESSENTIAL_NAMES]
    : POSIX_ESSENTIAL_NAMES;
}

function isEnvName(name: unknown): name is string {
  return (
    typeof name === "string" && name.length > 0 && !name.includes("=") && !name.includes("\u0000")
  );
}

function validateEnvNames(option: string, names: unknown): readonly string[] {
  if (!Array.isArray(names) || !names.every(isEnvName)) {
    throw new Error(`Invalid ${option}: expected an array of non-empty names without NUL or '='`);
  }
  return names;
}

/** Validate and copy an embedder's name list once, when a client or runtime is constructed. */
export function snapshotEnvNames(option: string, names: unknown): string[] | undefined {
  return names === undefined ? undefined : [...validateEnvNames(option, names)];
}

function inheritedNameFilter(policy: InheritedEnvPolicy | undefined): (name: string) => boolean {
  const blocked = new Set((policy?.block ?? []).map(envNameKey));
  const allowed = policy?.allow
    ? new Set([...essentialNames(), ...policy.allow].map(envNameKey))
    : undefined;
  return (name) => {
    const key = envNameKey(name);
    if (key.startsWith(AUTH_GRANT_PREFIX)) {
      return true;
    }
    if (blocked.has(key)) {
      return false;
    }
    return !allowed || allowed.has(key) || ESSENTIAL_PREFIXES.some((p) => key.startsWith(p));
  };
}

/** Whether a parent environment name reaches agent children under this policy. */
export function isInheritedEnvName(policy: InheritedEnvPolicy | undefined, name: string): boolean {
  return inheritedNameFilter(policy)(name);
}

/** Whether the policy changes inheritance at all; with neither list set it does not. */
export function hasInheritedEnvPolicy(policy: InheritedEnvPolicy | undefined): boolean {
  return policy?.allow !== undefined || (policy?.block?.length ?? 0) > 0;
}

/** Copy the parent environment, keeping only the names this policy lets children inherit. */
export function inheritParentEnvironment(policy?: InheritedEnvPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!hasInheritedEnvPolicy(policy)) {
    return env;
  }
  validateEnvNames("agentProcessEnvAllow", policy?.allow ?? []);
  validateEnvNames("agentProcessEnvBlock", policy?.block ?? []);
  const inherits = inheritedNameFilter(policy);
  for (const name of Object.keys(env)) {
    if (!inherits(name)) {
      delete env[name];
    }
  }
  return env;
}
