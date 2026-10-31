import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIST_CLI_PATH = path.join(process.cwd(), "dist", "cli.js");
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type PackageJson = {
  version?: unknown;
  bin?: {
    acpx?: unknown;
  };
};

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function readPackageVersion(): string {
  const parsed = readPackageJson();
  const { version } = parsed;
  if (typeof version !== "string") {
    throw new Error("package.json version is missing");
  }
  return version;
}

function readPackageBinPath(): string {
  const parsed = readPackageJson();
  const binPath = parsed.bin?.acpx;
  if (typeof binPath !== "string" || binPath.length === 0) {
    throw new Error("package.json bin.acpx is missing");
  }
  return path.join(process.cwd(), binPath);
}

function packageBinSpawnArgs(args: string[]): {
  command: string;
  args: string[];
} {
  const binPath = readPackageBinPath();
  if (process.platform === "win32") {
    return { command: process.execPath, args: [binPath, ...args] };
  }
  return { command: binPath, args };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-packaged-bin-test-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function runPackageBin(args: string[], homeDir: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
    };
    delete env.NODE_V8_COVERAGE;

    const command = packageBinSpawnArgs(args);
    const child = spawn(command.command, command.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("packaged bin prints version through package executable mapping", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const result = await runPackageBin(["--version"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    assert.equal(result.stdout.trim(), readPackageVersion());
  });
});

test("packaged bin prints version with top-level output flags", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const result = await runPackageBin(["--json-strict", "--version"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    assert.equal(result.stdout.trim(), readPackageVersion());
  });
});

test("packaged bin runs a mock-agent exec command through package executable mapping", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runPackageBin(
      [
        "--agent",
        MOCK_AGENT_COMMAND,
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "exec",
        "echo packaged-bin-ok",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "packaged-bin-ok");
  });
});

test(
  "packaged bin identifies a missing executable in its spawn error",
  { skip: process.platform === "win32" },
  async () => {
    assert(existsSync(DIST_CLI_PATH), "run pnpm build before packaged-bin smoke tests");
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd);
      const missingAgent = path.join(homeDir, "missing-agent");
      const result = await runPackageBin(
        ["--cwd", cwd, "--agent", missingAgent, "exec", "ping"],
        homeDir,
      );
      assert.equal(result.code, 1);
      assert(result.stderr.includes(`Executable path could not be resolved: ${missingAgent}.`));
      assert.match(result.stderr, /required executable, interpreter, working directory/i);
    });
  },
);

test("packaged registry imports without runtime dependencies or agent execution", async () => {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-registry-package-"));
  try {
    await fs.cp(path.join(process.cwd(), "dist"), path.join(packageDir, "dist"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(process.cwd(), "package.json"),
      path.join(packageDir, "package.json"),
    );
    const adapterDir = path.join(packageDir, "node_modules", "pi-acp");
    await fs.mkdir(adapterDir, { recursive: true });
    await fs.writeFile(
      path.join(adapterDir, "package.json"),
      JSON.stringify({ name: "pi-acp", bin: { "pi-acp": "adapter.js" } }),
    );
    await fs.writeFile(path.join(adapterDir, "adapter.js"), "");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import path from 'node:path';
      const executions = [];
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        childProcess[name] = () => {
          executions.push(name);
          throw new Error('Unexpected process execution');
        };
      }
      syncBuiltinESMExports();
      const { createAgentRegistry } = await import('acpx/agent-registry');
      const registry = createAgentRegistry({
        resolveExecutable: command => ['opencode', 'pi'].includes(command) ? path.resolve('bin', command) : undefined,
      });
      assert.equal(registry.inspect('qwen').launch.kind, 'missing');
      assert.deepEqual(registry.inspect('opencode').launch, {
        kind: 'installed', argv: [path.resolve('bin', 'opencode'), 'acp'],
      });
      assert.deepEqual(registry.inspect('pi').launch, {
        kind: 'installed', argv: [process.execPath, path.resolve('node_modules/pi-acp/adapter.js')],
      });
      assert.ok(registry.list().includes('pi'));
      assert.deepEqual(registry.resolve('opencode'), ['npx', '-y', '--package=opencode-ai', '--', 'opencode', 'acp']);
      assert.deepEqual(executions, []);
    `,
      ],
      { cwd: packageDir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await fs.rm(packageDir, { recursive: true, force: true });
  }
});
