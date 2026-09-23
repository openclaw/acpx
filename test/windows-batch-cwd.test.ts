import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable } from "../src/acp/agent-command.js";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { AcpClient } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import {
  buildAgentSpawnCommand,
  resolveWindowsExecutablePath,
} from "../src/spawn-command-options.js";
import type { AcpProcessLaunch } from "../src/types.js";

type Layout = { parent: string; child: string };
const literalArgs = ["--profile", "with spaces", "a&b", "C:\\trailing\\"];
const env = { PATH: "bin", PATHEXT: ".EXE;.CMD;.BAT", COMSPEC: "cmd.exe" };

async function withLayout(run: (layout: Layout) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acpx-batch-cwd-")));
  const parent = path.join(root, "parent");
  const child = path.join(root, "selected workspace");
  const originalCwd = process.cwd();
  try {
    await fs.mkdir(path.join(parent, "bin"), { recursive: true });
    await fs.mkdir(path.join(child, "bin"), { recursive: true });
    process.chdir(parent);
    await run({ parent, child });
    assert.equal(process.cwd(), parent, "resolution must not switch the parent cwd");
  } finally {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function captureLaunch(
  command: string,
  cwd: string,
  platform: NodeJS.Platform = "win32",
): Promise<AcpProcessLaunch> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const refusal = new Error("fixture stops at process admission");
  let observed: AcpProcessLaunch | undefined;
  let spawned = false;
  let client: AcpClient | undefined;
  try {
    Object.defineProperty(process, "platform", { value: platform });
    client = new AcpClient({
      ...normalizeAgentCommandInput([command, ...literalArgs]),
      cwd,
      permissionMode: "deny-all",
      agentProcessEnv: env,
      processLifecycle: {
        onBeforeSpawn(launch) {
          observed = launch;
          throw refusal;
        },
        onSpawned() {
          spawned = true;
        },
      },
    });
    await assert.rejects(client.start(), (error: unknown) => error === refusal);
    assert.equal(spawned, false);
    assert(observed);
    assert.equal(observed.cwd, cwd);
    return observed;
  } finally {
    try {
      await client?.close();
    } finally {
      if (descriptor) {
        Object.defineProperty(process, "platform", descriptor);
      }
    }
  }
}

for (const extension of ["cmd", "bat"]) {
  for (const command of ["./bin/synthetic-agent", "synthetic-agent"]) {
    test(`Windows agent admission resolves ${command}.${extension} from child cwd`, async () => {
      await withLayout(async ({ parent, child }) => {
        const wrapper = path.join(child, "bin", `synthetic-agent.${extension}`);
        await fs.writeFile(wrapper, "@echo off\r\n");
        await fs.writeFile(path.join(parent, "bin", "synthetic-agent.exe"), "");
        const actual = await captureLaunch(command, child);
        const expected = buildAgentSpawnCommand(wrapper, literalArgs, "win32", env);
        assert.equal(actual.command, expected.command);
        assert.deepEqual(actual.args, expected.args);
      });
    });
  }
}

test("a parent batch wrapper does not change a child's native executable launch", async () => {
  await withLayout(async ({ parent, child }) => {
    await fs.writeFile(path.join(parent, "bin", "synthetic-agent.cmd"), "@echo off\r\n");
    await fs.writeFile(path.join(child, "bin", "synthetic-agent.exe"), "");
    const actual = await captureLaunch("synthetic-agent", child);
    assert.equal(actual.command, "synthetic-agent");
    assert.deepEqual(actual.args, literalArgs);
  });
});

test("a parent-only batch wrapper cannot supply child launch resolution", async () => {
  await withLayout(async ({ parent, child }) => {
    await fs.writeFile(path.join(parent, "bin", "synthetic-agent.cmd"), "@echo off\r\n");
    const actual = await captureLaunch("synthetic-agent", child);
    assert.equal(actual.command, "synthetic-agent");
    assert.deepEqual(actual.args, literalArgs);
  });
});

test("absolute batch launch and literal argument encoding remain unchanged", async () => {
  await withLayout(async ({ parent, child }) => {
    const wrapper = path.join(parent, "bin", "synthetic-agent.cmd");
    await fs.writeFile(wrapper, "@echo off\r\n");
    const actual = await captureLaunch(wrapper, child);
    const expected = buildAgentSpawnCommand(wrapper, literalArgs, "win32", env);
    assert.equal(actual.command, expected.command);
    assert.deepEqual(actual.args, expected.args);
  });
});

test("Unix launches retain their original command and literal argv", async () => {
  await withLayout(async ({ child }) => {
    await fs.writeFile(path.join(child, "bin", "synthetic-agent.cmd"), "@echo off\r\n");
    const actual = await captureLaunch("./bin/synthetic-agent", child, "linux");
    assert.equal(actual.command, "./bin/synthetic-agent");
    assert.deepEqual(actual.args, literalArgs);
  });
});

for (const command of ["./bin/synthetic-terminal", "synthetic-terminal"]) {
  test(`Windows terminal batch policy resolves ${command} from terminal cwd`, async () => {
    await withLayout(async ({ parent, child }) => {
      await fs.writeFile(path.join(parent, "bin", "synthetic-terminal.exe"), "");
      await fs.writeFile(path.join(child, "bin", "synthetic-terminal.cmd"), "@echo off\r\n");
      const options = buildTerminalSpawnOptions(
        command,
        child,
        Object.entries(env).map(([name, value]) => ({
          name: Object.keys(process.env).find((key) => key.toUpperCase() === name) ?? name,
          value,
        })),
        "win32",
      );
      assert.equal(options.cwd, child);
      assert.equal(options.shell, true);
    });
  });
}

// These typed views also compile against the baseline, which ignores the new
// trailing context argument. They contain no copied resolver implementation.
const resolveClaudeAtCwd: (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
) => string | undefined = resolveClaudeCodeExecutable;
const resolveExecutableAtCwd: (
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
) => string | undefined = resolveWindowsExecutablePath;

test("Claude native discovery uses relative PATH in the selected child cwd", async () => {
  await withLayout(async ({ parent, child }) => {
    await fs.writeFile(path.join(parent, "bin", "claude.exe"), "");
    const executable = path.join(child, "bin", "claude.exe");
    await fs.writeFile(executable, "");
    assert.equal(resolveClaudeAtCwd("win32", env, child), executable);
  });
});

test("a child-local Windows wrapper resolves its own native sibling entrypoint", async () => {
  await withLayout(async ({ child }) => {
    const nativeDir = path.join(child, "bin", "native");
    await fs.mkdir(nativeDir);
    const executable = path.join(nativeDir, "synthetic.exe");
    await fs.writeFile(executable, "");
    await fs.writeFile(
      path.join(child, "bin", "synthetic.cmd"),
      '@echo off\r\n"%~dp0native\\synthetic.exe" %*\r\n',
    );
    assert.equal(resolveExecutableAtCwd("synthetic", env, child), executable);
  });
});
