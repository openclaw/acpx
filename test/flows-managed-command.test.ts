import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FlowShellResult } from "../src/flows/types.js";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/flow-managed-command.js", import.meta.url));
type Report = {
  ending: string;
  result?: FlowShellResult;
  firstError?: string;
  nextError?: string;
  nextDispatched: boolean;
  signalAborted: boolean;
  acknowledgedTermination: boolean;
  aliveAtReturn: number[];
};

async function nativeCase(mode: string): Promise<Report> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-managed-command-"));
  try {
    const { stdout } = await exec(process.execPath, [fixture, root, mode], {
      cwd: root,
      env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH, TMPDIR: root },
      timeout: 15_000,
    });
    assert.equal(
      await fs.stat(path.join(root, "late-command")).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
          }
          throw error;
        },
      ),
      false,
    );
    return JSON.parse(stdout) as Report;
  } finally {
    await cleanupNativeChildren(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function cleanupNativeChildren(root: string): Promise<void> {
  // The PID list names only children created by this case, including on assertion/host failure.
  const pids = await fs.readFile(path.join(root, "owned-pids"), "utf8").catch(() => "");
  for (const value of pids.trim().split("\n")) {
    const pid = Number(value);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
}

test(
  "function command deadline escalates TERM and returns partial diagnostics",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("own-deadline");
    assert.equal(report.ending, "ok");
    assert.equal(
      report.acknowledgedTermination,
      true,
      "child must actually observe and ignore TERM",
    );
    assert.equal(report.result?.timedOut, true);
    assert.equal(report.result?.stdout, "partial stdout");
    assert.equal(report.result?.stderr, "partial stderr");
    assert.equal(report.result?.exitCode, null);
    assert.equal(report.result?.signal, "SIGKILL");
    assert.deepEqual(
      report.aliveAtReturn,
      [],
      "native cleanup must finish before the flow settles",
    );
  },
);

test(
  "outer node timeout joins native cleanup and denies a caught callback's next command",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("outer-timeout");
    assert.equal(report.ending, "TimeoutError");
    assert.equal(report.firstError, "TimeoutError");
    assert.equal(report.nextError, "TimeoutError");
    assert.equal(report.nextDispatched, false);
    assert.equal(report.signalAborted, true);
    assert.equal(report.acknowledgedTermination, true);
    assert.deepEqual(
      report.aliveAtReturn,
      [],
      "runner failure cannot leave the owned command alive",
    );
  },
);

test(
  "successful function command waits for inherited streams after wrapper exit",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const report = await nativeCase("stdio-close");
    assert.equal(report.ending, "ok");
    assert.equal(report.result?.stdout, "early stdoutlate stdout");
    assert.equal(report.result?.stderr, "late stderr");
    assert.equal(report.result?.exitCode, 0);
    assert.equal(report.result?.timedOut, false);
  },
);

test("function command returns ordinary nonzero diagnostics without ending the node", async () => {
  const report = await nativeCase("nonzero");
  assert.equal(report.ending, "ok");
  assert.equal(report.result?.stdout, "ordinary stdout");
  assert.equal(report.result?.stderr, "ordinary stderr");
  assert.equal(report.result?.exitCode, 7);
  assert.equal(report.result?.signal, null);
  assert.equal(report.result?.timedOut, false);
});
