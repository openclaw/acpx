import type { AcpClientOptions } from "../types.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildAuthEnvKey(methodId: string): string | undefined {
  const token = toEnvToken(methodId);
  return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : undefined;
}

const authEnvKeyCache = new Map<string, string | undefined>();

function authEnvKey(methodId: string): string | undefined {
  const cached = authEnvKeyCache.get(methodId);
  if (cached !== undefined) {
    return cached;
  }
  const key = buildAuthEnvKey(methodId);
  authEnvKeyCache.set(methodId, key);
  return key;
}

export function readEnvCredential(methodId: string): string | undefined {
  const key = authEnvKey(methodId);
  if (!key) {
    return undefined;
  }
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function protectedEnvKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

function isAuthEnvKey(key: string): boolean {
  return protectedEnvKey(key).startsWith(AUTH_ENV_PREFIX);
}

function authEnvSuffix(key: string): string {
  return key.slice(AUTH_ENV_PREFIX.length);
}

function protectEnvKey(protectedKeys: Set<string>, key: string): void {
  protectedKeys.add(protectedEnvKey(key));
}

function promotePrefixedAuthEnvironment(env: NodeJS.ProcessEnv): Set<string> {
  const protectedKeys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!isAuthEnvKey(key)) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const normalized = toEnvToken(authEnvSuffix(key));
    if (!normalized) {
      continue;
    }

    protectEnvKey(protectedKeys, key);
    protectEnvKey(protectedKeys, normalized);
    if (env[normalized] == null) {
      env[normalized] = value;
    }
  }
  return protectedKeys;
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
  sessionEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);
  if (authCredentials) {
    for (const [methodId, credential] of Object.entries(authCredentials)) {
      addAuthCredentialEnvKeys(protectedAuthEnvKeys, methodId, credential);
      assignAuthCredentialEnv(env, methodId, credential);
    }
  }

  if (sessionEnv) {
    for (const [key, value] of Object.entries(sessionEnv)) {
      if (typeof value !== "string" || protectedAuthEnvKeys.has(protectedEnvKey(key))) {
        continue;
      }
      assignSessionEnv(env, key, value);
    }
  }

  return env;
}

function assignSessionEnv(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const normalizedKey = protectedEnvKey(key);
  for (const existingKey of Object.keys(env)) {
    if (protectedEnvKey(existingKey) === normalizedKey) {
      delete env[existingKey];
    }
  }
  env[key] = value;
}

function addAuthCredentialEnvKeys(
  protectedKeys: Set<string>,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000")) {
    protectEnvKey(protectedKeys, methodId);
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    protectEnvKey(protectedKeys, `${AUTH_ENV_PREFIX}${normalized}`);
    protectEnvKey(protectedKeys, normalized);
  }
}

function assignAuthCredentialEnv(
  env: NodeJS.ProcessEnv,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000") && env[methodId] == null) {
    env[methodId] = credential;
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
    assignIfMissing(env, normalized, credential);
  }
}

function assignIfMissing(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env[key] == null) {
    env[key] = value;
  }
}

export function resolveConfiguredAuthCredential(
  methodId: string,
  authCredentials: AcpClientOptions["authCredentials"],
): string | undefined {
  const configCredentials = authCredentials ?? {};
  return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionEnv?: Record<string, string>,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(authCredentials, sessionEnv),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
