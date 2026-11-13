import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  inspectAgentModels,
  type AcpAgentSpawner,
} from "../src/runtime.js";

const AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("host spawning applies to runtime probes, sessions, reconnects, and model inspection", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-host-spawn-"));
  const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawnAgent: AcpAgentSpawner = (input) => {
    launches.push(input);
    return spawn(process.execPath, [AGENT, ...input.args], input.options);
  };
  const options = {
    cwd,
    spawnAgent,
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: ["acpx-host-only-fixture", "--supports-load-session", "--advertise-models"],
      },
    }),
    sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
    permissionMode: "deny-all" as const,
    probeAgent: "fixture",
  };
  const first = createAcpRuntime(options);
  const second = createAcpRuntime(options);
  t.after(async () => {
    await Promise.all([first.shutdown(), second.shutdown()]);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  assert.equal((await first.doctor()).ok, true);
  assert.equal(launches.length, 1);
  const handle = await first.ensureSession({
    sessionKey: "host-spawn",
    agent: "fixture",
    mode: "persistent",
  });
  await first.shutdown();
  await second.setMode({ handle, mode: "plan" });
  assert.equal(launches.length, 3);
  const inspectionOptions = {
    cwd,
    agentCommand: ["acpx-host-only-fixture", "--advertise-models"],
    spawnAgent,
  };
  const models = await inspectAgentModels(inspectionOptions);
  assert.equal(models?.currentModelId, "default-model");
  assert.equal(launches.length, 4);
  for (const launch of launches) {
    assert.equal(launch.command, "acpx-host-only-fixture");
    assert.equal(launch.options.cwd, cwd);
    assert.deepEqual(launch.options.stdio, ["pipe", "pipe", "pipe"]);
    assert(launch.args.includes("--advertise-models"));
  }
});

test("host spawning also owns native compatibility probes", async () => {
  const invocations: Array<{ args: string[]; options: SpawnOptions }> = [];
  const lifecycle: string[] = [];
  const client = new AcpClient({
    cwd: process.cwd(),
    agentCommand: "gemini --acp",
    permissionMode: "deny-all",
    processLifecycle: {
      onBeforeSpawn: ({ args }) => {
        lifecycle.push(`before:${args[0]}`);
      },
      onSpawned: ({ args }) => {
        lifecycle.push(`started:${args[0]}`);
      },
      onExit: ({ args }) => {
        lifecycle.push(`exit:${args[0]}`);
      },
    },
    spawnAgent: ({ command, args, options }) => {
      assert.equal(command, "gemini");
      lifecycle.push(`spawn:${args[0]}`);
      invocations.push({ args, options });
      return spawn(
        process.execPath,
        args.includes("--version")
          ? ["-e", "console.log('0.31.0')"]
          : [AGENT, "--advertise-models"],
        options,
      );
    },
  });
  try {
    await client.start();
  } finally {
    await client.close();
  }
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].args, ["--version"]);
  assert.deepEqual(invocations[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(invocations[1].args, ["--experimental-acp"]);
  assert.deepEqual(lifecycle, [
    "before:--version",
    "spawn:--version",
    "started:--version",
    "exit:--version",
    "before:--experimental-acp",
    "spawn:--experimental-acp",
    "started:--experimental-acp",
    "exit:--experimental-acp",
  ]);
});

test("host children with invalid piped stdio are stopped before startup rejects", async (t) => {
  let child: ChildProcess | undefined;
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    permissionMode: "deny-all",
    spawnAgent: ({ command, args, options }) => {
      child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      return child;
    },
  });
  t.after(async () => {
    child?.kill("SIGKILL");
    await client.close();
  });
  await assert.rejects(client.start(), /piped stdin\/stdout\/stderr/u);
  assert(child);
  assert(child.exitCode !== null || child.signalCode !== null, "invalid host child must exit");
});
