import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleMainRejection } from "../src/cli.js";

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
    import { handleMainRejection } from ${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))};
    handleMainRejection(new Error("spawned boom"));
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[acpx\] spawned boom/);
  assert.equal(result.stdout, "");
});

test("spawned handleStreamError EPIPE exits 0 without diagnostic", async () => {
  const result = await spawnEval(`
    import { handleStreamError } from ${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))};
    const err = new Error("broken pipe");
    err.code = "EPIPE";
    handleStreamError(err);
  `);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("spawned handleStreamError non-EPIPE writes diagnostic and exits 1", async () => {
  const result = await spawnEval(`
    import { handleStreamError } from ${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))};
    const err = new Error("EIO on stdout");
    err.code = "EIO";
    handleStreamError(err);
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[acpx\] stream error: EIO on stdout/);
});

test("writeFatalLine is usable when stderr is a pipe", async () => {
  const result = await spawnEval(`
    import { writeFatalLine } from ${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))};
    writeFatalLine("[acpx] sync write ok");
  `);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /\[acpx\] sync write ok/);
});

function spawnEval(
  source: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
