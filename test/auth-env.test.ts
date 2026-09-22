import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { buildAgentSpawnOptions } from "../src/acp/auth-env.js";

function buildSyntheticAuthEnvironment(
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv,
  credentials?: Record<string, string>,
  sessionEnv?: Record<string, string>,
  runtimeEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const originalEnvironment = process.env;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const parentEnvironment = { ...inherited };
  process.env = parentEnvironment;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const options = buildAgentSpawnOptions(os.tmpdir(), credentials, sessionEnv, runtimeEnv);
    assert.equal(process.env, parentEnvironment);
    assert.deepEqual(parentEnvironment, inherited);
    return options.env;
  } finally {
    process.env = originalEnvironment;
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
}

const windowsAuthCases: Array<{
  name: string;
  inherited: NodeJS.ProcessEnv;
  credentials: Record<string, string> | undefined;
  expected: NodeJS.ProcessEnv;
}> = [
  {
    name: "config preserves a differently cased inherited native credential",
    inherited: { api_token: "synthetic-parent" },
    credentials: { "api-token": "synthetic-config" },
    expected: {
      api_token: "synthetic-parent",
      "api-token": "synthetic-config",
      ACPX_AUTH_API_TOKEN: "synthetic-config",
    },
  },
  {
    name: "prefixed promotion preserves a differently cased native credential",
    inherited: {
      ACPX_AUTH_API_TOKEN: "synthetic-explicit",
      api_token: "synthetic-parent",
    },
    credentials: undefined,
    expected: {
      ACPX_AUTH_API_TOKEN: "synthetic-explicit",
      api_token: "synthetic-parent",
    },
  },
  {
    name: "config preserves a differently cased inherited prefixed credential",
    inherited: { acpx_auth_api_token: "synthetic-explicit" },
    credentials: { "api-token": "synthetic-config" },
    expected: {
      acpx_auth_api_token: "synthetic-explicit",
      API_TOKEN: "synthetic-explicit",
      "api-token": "synthetic-config",
    },
  },
  {
    name: "config preserves a differently cased inherited raw method credential",
    inherited: { "api-token": "synthetic-parent-raw" },
    credentials: { "API-TOKEN": "synthetic-config" },
    expected: {
      "api-token": "synthetic-parent-raw",
      ACPX_AUTH_API_TOKEN: "synthetic-config",
      API_TOKEN: "synthetic-config",
    },
  },
];

for (const entry of windowsAuthCases) {
  test(`Windows auth environment: ${entry.name}`, () => {
    const env = buildSyntheticAuthEnvironment("win32", entry.inherited, entry.credentials);
    assert.deepEqual(env, entry.expected);
    const names = Object.keys(env).map((key) => key.toUpperCase());
    assert.equal(new Set(names).size, names.length);
  });
}

for (const inheritedValue of ["", "  "]) {
  test(`Windows auth defaults preserve an inherited ${JSON.stringify(inheritedValue)} value`, () => {
    const env = buildSyntheticAuthEnvironment(
      "win32",
      { api_token: inheritedValue },
      { "api-token": "synthetic-config" },
    );
    assert.equal(env.api_token, inheritedValue);
    assert.equal(Object.hasOwn(env, "API_TOKEN"), false);
  });
}

test("auth defaults still fill missing aliases on Windows", () => {
  assert.deepEqual(
    buildSyntheticAuthEnvironment("win32", {}, { "api-token": "synthetic-config" }),
    {
      "api-token": "synthetic-config",
      ACPX_AUTH_API_TOKEN: "synthetic-config",
      API_TOKEN: "synthetic-config",
    },
  );
});

test("auth defaults preserve exact-case inherited values on Windows", () => {
  const inherited = {
    "api-token": "synthetic-raw",
    ACPX_AUTH_API_TOKEN: "synthetic-explicit",
    API_TOKEN: "synthetic-native",
  };
  assert.deepEqual(
    buildSyntheticAuthEnvironment("win32", inherited, { "api-token": "synthetic-config" }),
    inherited,
  );
});

test("auth defaults retain case-sensitive environment names on Unix", () => {
  const inherited = {
    "API-TOKEN": "synthetic-raw",
    acpx_auth_api_token: "synthetic-prefixed",
    api_token: "synthetic-native",
  };
  assert.deepEqual(
    buildSyntheticAuthEnvironment("linux", inherited, { "api-token": "synthetic-config" }),
    {
      ...inherited,
      "api-token": "synthetic-config",
      ACPX_AUTH_API_TOKEN: "synthetic-config",
      API_TOKEN: "synthetic-config",
    },
  );
});

test("Windows auth defaults ignore undefined entries without losing the configured value", () => {
  const env = buildSyntheticAuthEnvironment(
    "win32",
    { api_token: undefined },
    { "api-token": "synthetic-config" },
  );
  assert.equal(env.API_TOKEN, "synthetic-config");
  assert.equal(env.ACPX_AUTH_API_TOKEN, "synthetic-config");
});

test("session and runtime overlays preserve case-equivalent inherited auth values on Windows", () => {
  const inherited = {
    acpx_auth_api_token: "synthetic-explicit",
    api_token: "synthetic-native",
    "api-token": "synthetic-raw",
    ORDINARY_SETTING: "parent",
  };
  const env = buildSyntheticAuthEnvironment(
    "win32",
    inherited,
    { "API-TOKEN": "synthetic-config" },
    {
      ACPX_AUTH_API_TOKEN: "session-prefixed",
      API_TOKEN: "session-native",
      "API-TOKEN": "session-raw",
      ORDINARY_SETTING: "session",
    },
    {
      Acpx_Auth_Api_Token: "runtime-prefixed",
      Api_Token: "runtime-native",
      "Api-Token": "runtime-raw",
      ordinary_setting: "runtime",
    },
  );
  assert.deepEqual(env, {
    acpx_auth_api_token: "synthetic-explicit",
    api_token: "synthetic-native",
    "api-token": "synthetic-raw",
    ordinary_setting: "runtime",
  });
});
