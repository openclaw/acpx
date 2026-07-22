import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleMainRejection } from "../src/cli-fatal.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_CLI = path.join(ROOT, "dist", "cli.js");
const CLI_FATAL_TS = fileURLToPath(new URL("../src/cli-fatal.ts", import.meta.url));

test("importing the CLI module does not install entrypoint-only process state", async () => {
  const stdoutErrorListeners = process.stdout.listeners("error");
  const stderrErrorListeners = process.stderr.listeners("error");
  const previousQueueOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
  const previousExecArgv = [...process.execArgv];

  process.execArgv.splice(0, process.execArgv.length, "--import", "acpx-test-loader");
  delete process.env.ACPX_QUEUE_OWNER_ARGS;

  try {
    await import(`../src/cli.js?entrypoint-side-effects=${Date.now()}`);

    assert.deepEqual(process.stdout.listeners("error"), stdoutErrorListeners);
    assert.deepEqual(process.stderr.listeners("error"), stderrErrorListeners);
    assert.equal(process.env.ACPX_QUEUE_OWNER_ARGS, undefined);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
    if (previousQueueOwnerArgs == null) {
      delete process.env.ACPX_QUEUE_OWNER_ARGS;
    } else {
      process.env.ACPX_QUEUE_OWNER_ARGS = previousQueueOwnerArgs;
    }
  }
});

test("package root does not export fatal handlers", async () => {
  assert.ok(fs.existsSync(DIST_CLI), "dist/cli.js must exist (run pnpm build)");
  const mod = await import(`${pathToFileURL(DIST_CLI).href}?exports=${Date.now()}`);
  assert.equal("handleMainRejection" in mod, false);
  assert.equal("handleStreamError" in mod, false);
  assert.equal("writeFatalLine" in mod, false);
  assert.equal(typeof mod.parseAllowedTools, "function");
});

test("handleMainRejection sets process.exitCode to 1", () => {
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    handleMainRejection(new Error("top-level boom"));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous;
  }
});

test("spawned handleMainRejection writes [acpx] diagnostic and exits 1", async () => {
  const result = await spawnEval(`
    import { handleMainRejection } from ${JSON.stringify(CLI_FATAL_TS)};
    handleMainRejection(new Error("spawned boom"));
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[acpx\] Error: spawned boom/);
  // Unexpected errors keep Node-style stack (file/line), not message-only.
  assert.match(result.stderr, /at /);
  assert.equal(result.stdout, "");
});

test("spawned handleStreamError EPIPE exits 0 without diagnostic", async () => {
  const result = await spawnEval(`
    import { handleStreamError } from ${JSON.stringify(CLI_FATAL_TS)};
    const err = new Error("broken pipe");
    err.code = "EPIPE";
    handleStreamError(err);
  `);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("spawned handleStreamError non-EPIPE writes diagnostic and exits 1", async () => {
  const result = await spawnEval(`
    import { handleStreamError } from ${JSON.stringify(CLI_FATAL_TS)};
    const err = new Error("EIO on stdout");
    err.code = "EIO";
    handleStreamError(err);
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[acpx\] stream error: EIO on stdout/);
});

test("writeFatalLine is usable when stderr is a pipe", async () => {
  const result = await spawnEval(`
    import { writeFatalLine } from ${JSON.stringify(CLI_FATAL_TS)};
    writeFatalLine("[acpx] sync write ok");
  `);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /\[acpx\] sync write ok/);
});

test("built acpx entrypoint path: main rejection prints [acpx] diagnostic", async () => {
  assert.ok(fs.existsSync(DIST_CLI), "dist/cli.js must exist (run pnpm build)");
  // Real Node process using the same fatal handler wired by dist/cli.js entry.
  // Mirrors: void main(process.argv).catch(handleMainRejection)
  const harness = path.join(ROOT, "scripts", "proof-main-reject.mjs");
  fs.mkdirSync(path.dirname(harness), { recursive: true });
  fs.writeFileSync(
    harness,
    `import { handleMainRejection } from ${JSON.stringify(pathToFileURL(CLI_FATAL_TS).href)};
const main = async () => {
  throw new Error("proof main rejection via acpx fatal path");
};
void main().catch(handleMainRejection);
`,
  );
  try {
    const result = await spawnNode(["--import", "tsx", harness]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /\[acpx\] Error: proof main rejection via acpx fatal path/);
    assert.match(result.stderr, /at /);
  } finally {
    fs.rmSync(harness, { force: true });
  }
});

test("built package bin --version works (entrypoint health)", async () => {
  assert.ok(fs.existsSync(DIST_CLI), "dist/cli.js must exist (run pnpm build)");
  const result = await spawnNode([DIST_CLI, "--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\d+\.\d+/);
});

function spawnEval(
  source: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return spawnNode(["--import", "tsx", "--input-type=module", "-e", source]);
}

function spawnNode(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
