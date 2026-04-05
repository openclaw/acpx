import type { AcpClientOptions } from "../types.js";

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildAuthEnvKeys(methodId: string): string[] {
  const token = toEnvToken(methodId);
  const keys = new Set<string>([methodId]);
  if (token) {
    keys.add(token);
    keys.add(`ACPX_AUTH_${token}`);
  }
  return [...keys];
}

const authEnvKeysCache = new Map<string, string[]>();

function authEnvKeys(methodId: string): string[] {
  const cached = authEnvKeysCache.get(methodId);
  if (cached) {
    return cached;
  }
  const keys = buildAuthEnvKeys(methodId);
  authEnvKeysCache.set(methodId, keys);
  return keys;
}

export function readEnvCredential(methodId: string): string | undefined {
  for (const key of authEnvKeys(methodId)) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    if (typeof credential !== "string" || credential.trim().length === 0) {
      continue;
    }

    if (!methodId.includes("=") && !methodId.includes("\u0000") && env[methodId] == null) {
      env[methodId] = credential;
    }

    const normalized = toEnvToken(methodId);
    if (normalized) {
      const prefixed = `ACPX_AUTH_${normalized}`;
      if (env[prefixed] == null) {
        env[prefixed] = credential;
      }
      if (env[normalized] == null) {
        env[normalized] = credential;
      }
    }
  }

  return env;
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
