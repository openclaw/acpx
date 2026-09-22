import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  DriverResult,
  FixtureConfig,
  PeerProfile,
  PeerTrace,
  Source,
} from "./fixtures/preflight-context.js";

const runFile = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/preflight-context.js", import.meta.url));
const modern: PeerProfile = { version: "0.33.0", flag: "--acp" };
const newer: PeerProfile = { version: "0.41.1", flag: "--acp" };
const old: PeerProfile = { version: "0.32.9", flag: "--experimental-acp" };
const unsupported: PeerProfile = { version: "0.0.0", flag: null };

type Case = {
  name: string;
  agent: FixtureConfig["agent"];
  profiles: FixtureConfig["profiles"];
  expectedSource: Source;
  relative?: boolean;
  alignedParentContext?: boolean;
  parentHasGeminiKey?: boolean;
  sessionEnv?: Record<string, string>;
  authCredentials?: Record<string, string>;
  outcome: "initialized" | "unsupported" | "timeout";
  expectedFlag?: string;
  missingKeyHint?: boolean;
  hasGeminiKey?: boolean;
  hasGoogleKey?: boolean;
};

const cases: Case[] = [
  {
    name: "session PATH selects the older Gemini for version and launch",
    agent: "gemini",
    profiles: { parent: modern, session: old },
    expectedSource: "session",
    outcome: "initialized",
    expectedFlag: "--experimental-acp",
  },
  {
    name: "runtime PATH selects supported Copilot despite two unsupported alternatives",
    agent: "copilot",
    profiles: { parent: unsupported, session: unsupported, runtime: modern },
    expectedSource: "runtime",
    outcome: "initialized",
    expectedFlag: "--acp",
  },
  {
    name: "relative Gemini version probe uses the explicit child cwd",
    agent: "gemini",
    profiles: { parent: modern, session: old },
    expectedSource: "session",
    relative: true,
    outcome: "initialized",
    expectedFlag: "--experimental-acp",
  },
  {
    name: "unsupported selected Copilot and its diagnostic ignore supported parent",
    agent: "copilot",
    profiles: { parent: modern, session: unsupported },
    expectedSource: "session",
    outcome: "unsupported",
  },
  {
    name: "Gemini timeout diagnostics see selected version and config-derived auth presence",
    agent: "gemini",
    profiles: { parent: modern, session: { ...newer, silentInitialize: true } },
    expectedSource: "session",
    authCredentials: { "gemini-api-key": "synthetic-not-a-provider-key" },
    outcome: "timeout",
    expectedFlag: "--acp",
    missingKeyHint: false,
    hasGeminiKey: true,
  },
  {
    name: "Gemini timeout diagnostics report keys removed by selected child environment",
    agent: "gemini",
    profiles: { parent: modern, session: { ...newer, silentInitialize: true } },
    expectedSource: "session",
    parentHasGeminiKey: true,
    sessionEnv: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" },
    outcome: "timeout",
    expectedFlag: "--acp",
    missingKeyHint: true,
  },
  {
    name: "aligned modern Gemini retains the existing ACP flag",
    agent: "gemini",
    profiles: { parent: old, session: modern },
    expectedSource: "session",
    alignedParentContext: true,
    outcome: "initialized",
    expectedFlag: "--acp",
  },
  {
    name: "aligned unsupported Copilot retains the actionable admission error",
    agent: "copilot",
    profiles: { parent: modern, session: unsupported },
    expectedSource: "session",
    alignedParentContext: true,
    outcome: "unsupported",
  },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

for (const scenario of cases) {
  test(scenario.name, { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acpx-preflight-")));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    const bins: Record<Source, string> = {
      parent: path.join(root, "parent-bin"),
      session: path.join(root, "workspace", "bin"),
      runtime: path.join(root, "runtime-bin"),
    };
    const parentCwd = path.join(root, "parent-cwd");
    const home = path.join(root, "home");
    await Promise.all(
      [...Object.values(bins), parentCwd, home].map((directory) =>
        fs.mkdir(directory, { recursive: true }),
      ),
    );
    const childPath = (source: Source) =>
      `${bins[source]}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const config: FixtureConfig = {
      root,
      agent: scenario.agent,
      relative: scenario.relative,
      profiles: scenario.profiles,
      sessionEnv: { ...scenario.sessionEnv, PATH: childPath("session") },
      runtimeEnv: scenario.profiles.runtime ? { PATH: childPath("runtime") } : undefined,
      authCredentials: scenario.authCredentials,
    };
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    for (const source of ["parent", "session", "runtime"] as const) {
      if (!config.profiles[source]) {
        continue;
      }
      const args = [process.execPath, fixturePath, "peer", configPath, source];
      await fs.writeFile(
        path.join(bins[source], scenario.agent),
        `#!/bin/sh\nexec ${args.map(shellQuote).join(" ")} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const parentEnv: NodeJS.ProcessEnv = {
      HOME: home,
      TMPDIR: root,
      PATH: childPath(scenario.alignedParentContext ? "session" : "parent"),
      LANG: "C",
      LC_ALL: "C",
      ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS: scenario.outcome === "timeout" ? "1000" : "5000",
    };
    if (scenario.parentHasGeminiKey) {
      parentEnv.GEMINI_API_KEY = "synthetic-not-a-provider-key";
    }
    const { stdout, stderr } = await runFile(
      process.execPath,
      [fixturePath, "driver", configPath],
      {
        cwd: scenario.alignedParentContext ? path.join(root, "workspace") : parentCwd,
        env: parentEnv,
        encoding: "utf8",
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
    );
    assert.equal(stderr, "");
    const result = JSON.parse(stdout) as DriverResult;
    assert.equal(result.parentUnchanged, true);
    assert.equal(result.initialized, scenario.outcome === "initialized", result.message ?? "");
    if (scenario.outcome === "unsupported") {
      assert.equal(result.errorName, "CopilotAcpUnsupportedError");
      assert.match(result.message ?? "", /Detected copilot --help output without --acp support/);
    } else if (scenario.outcome === "timeout") {
      assert.equal(result.errorName, "GeminiAcpStartupTimeoutError");
      assert.match(result.message ?? "", /Detected Gemini CLI version: 0\.41\.1\./);
      assert.equal(
        (result.message ?? "").includes("No GEMINI_API_KEY or GOOGLE_API_KEY"),
        scenario.missingKeyHint,
      );
      assert.equal((result.message ?? "").includes("synthetic-not-a-provider-key"), false);
    }
    const trace = (await fs.readFile(path.join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PeerTrace);
    assert.equal(
      trace.every((entry) => entry.event === "invocation"),
      true,
      "fixture safety deadline fired",
    );
    const probeArg = scenario.agent === "gemini" ? "--version" : "--help";
    const probes = trace.filter((entry) => entry.args[0] === probeArg);
    const launches = trace.filter((entry) => entry.args[0] !== probeArg);
    assert.equal(probes.length, scenario.outcome === "timeout" ? 2 : 1);
    assert.equal(launches.length, scenario.outcome === "unsupported" ? 0 : 1);
    for (const entry of trace) {
      assert.equal(entry.source, scenario.expectedSource);
      assert.equal(entry.cwd, path.join(root, "workspace"));
      assert.equal(entry.hasGeminiKey, scenario.hasGeminiKey ?? false);
      assert.equal(entry.hasGoogleKey, scenario.hasGoogleKey ?? false);
    }
    if (launches.length > 0) {
      assert.equal(launches[0]?.args[0], scenario.expectedFlag);
    }
  });
}
