import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const fixtureAgent = fileURLToPath(
  new URL("./fixtures/control-authority-agent.js", import.meta.url),
);

type Result = { code: number | null; stdout: string; stderr: string };
type Control = { sequence: number; method: string; value: string };

type Markers = {
  add: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
};

async function withFixture(
  run: (
    execute: (args: string[]) => Promise<Result>,
    controls: () => Promise<Control[]>,
    show: () => Promise<Record<string, unknown>>,
    markers: Markers,
  ) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-config-verbatim-"));
  const cwd = path.join(home, "workspace");
  const markersPath = path.join(home, "markers");
  await fs.mkdir(cwd);
  await fs.mkdir(markersPath);
  await fs.mkdir(path.join(home, ".acpx"));
  await fs.writeFile(
    path.join(home, ".acpx/config.json"),
    JSON.stringify({
      agents: { fixture: { argv: [process.execPath, fixtureAgent, markersPath, "config"] } },
    }),
  );
  for (const name of ["no-load", "received.jsonl", "effects.jsonl"]) {
    await fs.writeFile(path.join(markersPath, name), "");
  }

  const execute = async (args: string[]): Promise<Result> => {
    const child = spawn(
      process.execPath,
      [cli, "--cwd", cwd, "--timeout", "5", "--format", "json", "fixture", ...args],
      { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  };

  const controls = async (): Promise<Control[]> =>
    (await fs.readFile(path.join(markersPath, "received.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Control);

  const show = async (): Promise<Record<string, unknown>> => {
    const result = await execute(["sessions", "show", "padded"]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  const markers: Markers = {
    add: async (name: string) => fs.writeFile(path.join(markersPath, name), ""),
    remove: async (name: string) => fs.rm(path.join(markersPath, name), { force: true }),
  };

  try {
    await run(execute, controls, show, markers);
  } finally {
    await execute(["sessions", "close", "padded"]).catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
}

function setConfig(execute: (args: string[]) => Promise<Result>, name: string, args: string[]) {
  return execute(["set", "-s", name, ...args]);
}

test("set sends a non-model config value exactly as typed", async () => {
  await withFixture(async (execute, controls, show) => {
    const created = await execute(["sessions", "new", "--name", "padded"]);
    assert.equal(created.code, 0, created.stderr);

    const padded = await setConfig(execute, "padded", ["effort", " high "]);
    assert.equal(padded.code, 0, padded.stdout + padded.stderr);
    assert.deepEqual(await controls(), [
      { sequence: 1, method: "session/set_config_option", value: " high " },
    ]);

    const record = await show();
    const acpx = record.acpx as { desired_config_options?: Record<string, string> } | undefined;
    assert.equal(acpx?.desired_config_options?.effort, " high ");
  });
});

test("set still trims the values it normalizes for model selection", async () => {
  await withFixture(async (execute, controls, show) => {
    const created = await execute(["sessions", "new", "--name", "padded"]);
    assert.equal(created.code, 0, created.stderr);

    const shorthand = await setConfig(execute, "padded", ["model", " first-model "]);
    assert.equal(shorthand.code, 0, shorthand.stdout + shorthand.stderr);

    const advertised = await setConfig(execute, "padded", ["llm", " second-model "]);
    assert.equal(advertised.code, 0, advertised.stdout + advertised.stderr);

    assert.deepEqual(
      (await controls()).map((control) => control.value),
      ["first-model", "second-model"],
    );

    const record = await show();
    const acpx = record.acpx as { session_options?: { model?: string } } | undefined;
    assert.equal(acpx?.session_options?.model, "second-model");
  });
});

test("set trims a model selector the connected catalog gains on reconnect", async () => {
  await withFixture(async (execute, controls, show, markers) => {
    // Saved without the model control; the catalog gains "llm" on the next load.
    await markers.add("remove-model-control");
    const created = await execute(["sessions", "new", "--name", "padded"]);
    assert.equal(created.code, 0, created.stderr);
    await markers.remove("remove-model-control");

    const advertised = await setConfig(execute, "padded", ["llm", " second-model "]);
    assert.equal(advertised.code, 0, advertised.stdout + advertised.stderr);

    assert.deepEqual(
      (await controls()).map((control) => control.value),
      ["second-model"],
    );

    const record = await show();
    const acpx = record.acpx as { session_options?: { model?: string } } | undefined;
    assert.equal(acpx?.session_options?.model, "second-model");
  });
});

test("set trims a model selector the connected catalog renames on reconnect", async () => {
  await withFixture(async (execute, controls, _show, markers) => {
    const created = await execute(["sessions", "new", "--name", "padded"]);
    assert.equal(created.code, 0, created.stderr);

    // The catalog renames its model control from "llm" to "llm2" on reconnect.
    await markers.add("rename-model-control");

    const advertised = await setConfig(execute, "padded", ["llm2", " second-model "]);
    assert.equal(advertised.code, 0, advertised.stdout + advertised.stderr);

    assert.deepEqual(
      (await controls()).map((control) => control.value),
      ["second-model"],
    );
  });
});
