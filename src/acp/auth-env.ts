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

function promotePrefixedAuthEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AUTH_ENV_PREFIX)) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const normalized = key.slice(AUTH_ENV_PREFIX.length);
    if (!normalized || env[normalized] != null) {
      continue;
    }

    env[normalized] = value;
  }
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  promotePrefixedAuthEnvironment(env);
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    assignAuthCredentialEnv(env, methodId, credential);
  }

  return env;
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
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(authCredentials),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
