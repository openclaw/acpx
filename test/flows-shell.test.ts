import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  resolveShellActionTimeoutMs,
  runShellAction,
} from "../src/flows/executors/shell.js";

function runHostScript(script: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
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
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

test("renderShellCommand quotes arguments consistently", () => {
  assert.equal(renderShellCommand("echo", ["hello", "two words"]), 'echo "hello" "two words"');
});

test("formatShellActionSummary prefixes rendered commands", () => {
  assert.equal(
    formatShellActionSummary({
      command: "git",
      args: ["status", "--short"],
    }),
    'shell: git "status" "--short"',
  );
});

test("runShellAction captures stdout and stderr", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ok"); process.stderr.write("warn");'],
  });

  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.combinedOutput, "okwarn");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runShellAction allows non-zero exits when requested", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    allowNonZeroExit: true,
  });

  assert.equal(result.exitCode, 3);
});

test("runShellAction rejects non-zero exits by default", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("boom"); process.exit(2)'],
      }),
    /Shell action failed/,
  );
});

test("runShellAction times out long-running commands", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 50,
      }),
    (error: unknown) => error instanceof TimeoutError,
  );
});

test("resolveShellActionTimeoutMs treats non-positive as no deadline", () => {
  assert.equal(resolveShellActionTimeoutMs(undefined), undefined);
  assert.equal(resolveShellActionTimeoutMs(0), undefined);
  assert.equal(resolveShellActionTimeoutMs(-1), undefined);
  assert.equal(resolveShellActionTimeoutMs(50), 50);
});

test("runShellAction treats timeoutMs 0 as no deadline", async () => {
  const started = Date.now();
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 80)"],
    timeoutMs: 0,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started >= 70, "command should run to completion without a 1ms kill");
});

test("runShellAction reaps child when abort signal fires", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-abort-"));
  const pidFile = path.join(tmpDir, "pid");
  const ac = new AbortController();
  const pending = runShellAction(
    {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)`,
      ],
    },
    { signal: ac.signal },
  );

  let pid: number | undefined;
  for (let i = 0; i < 50; i += 1) {
    try {
      pid = Number(await fs.readFile(pidFile, "utf8"));
      if (Number.isFinite(pid) && pid > 0) {
        break;
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(pid && pid > 0, "child should write pid");
  const childPid = pid;

  ac.abort();
  await assert.rejects(
    async () => await pending,
    (error: unknown) => error instanceof TimeoutError,
  );

  // Child must be reaped (process gone).
  await new Promise((r) => setTimeout(r, 50));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "aborted shell child should be reaped");
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("runShellAction rejects commands terminated by signal", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: "/bin/sh",
        args: ["-c", 'kill -TERM "$$"'],
      }),
    /signal SIGTERM/,
  );
});

test("runShellAction does not crash the host when the child exits before reading stdin", async () => {
  const moduleUrl = new URL("../src/flows/executors/shell.js", import.meta.url).href;
  const host = await runHostScript(`
    import { runShellAction } from ${JSON.stringify(moduleUrl)};
    const result = await runShellAction({
      command: process.execPath,
      args: ["-e", "setImmediate(() => process.exit(0))"],
      stdin: "x".repeat(1024 * 1024),
      allowNonZeroExit: true,
    });
    process.stdout.write(JSON.stringify({
      exitCode: result.exitCode,
      signal: result.signal,
    }));
  `);

  assert.equal(host.exitCode, 0, host.stderr);
  assert.doesNotMatch(host.stderr, /EPIPE|uncaughtException|Unhandled/);
  const payload = JSON.parse(host.stdout) as { exitCode: number | null; signal: string | null };
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.signal, null);
});
