import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildQueueOwnerArgOverride,
  queueOwnerRuntimeOptionsFromSend,
  resolveQueueOwnerSpawnArgs,
  sanitizeQueueOwnerExecArgv,
  spawnQueueOwnerProcess,
} from "../src/session/execution/queue-owner-process.js";
import { queueOwnerRuntimeTestInternals } from "../src/session/execution/queue-owner-runtime.js";
import { sessionControlTestInternals } from "../src/session/execution/session-control.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acpx-queue-owner-path-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("resolveQueueOwnerSpawnArgs", () => {
  it("prefers ACPX_QUEUE_OWNER_ARGS when provided", () => {
    const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
      "--import",
      "tsx",
      "src/cli.ts",
      "__queue-owner",
    ]);
    try {
      const args = resolveQueueOwnerSpawnArgs(["node", "ignored.js"]);
      assert.deepEqual(args, ["--import", "tsx", "src/cli.ts", "__queue-owner"]);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previous;
      }
    }
  });

  it("returns <real cli path> and __queue-owner", async () => {
    await withTempDir(async (dir) => {
      const cliFile = path.join(dir, "cli.js");
      const cliLink = path.join(dir, "acpx-link.js");
      await writeFile(cliFile, "// stub\n", "utf8");
      await symlink(cliFile, cliLink);

      const args = resolveQueueOwnerSpawnArgs(["node", cliLink]);
      assert.deepEqual(args, [realpathSync(cliLink), "__queue-owner"]);
    });
  });

  it("throws when argv lacks an entry path", () => {
    assert.throws(() => resolveQueueOwnerSpawnArgs(["node"]), {
      message: "acpx self-spawn failed: missing CLI entry path",
    });
  });
});

describe("sanitizeQueueOwnerExecArgv", () => {
  it("drops test runner coverage flags but keeps loader args", () => {
    assert.deepEqual(
      sanitizeQueueOwnerExecArgv([
        "--experimental-test-coverage",
        "--test",
        "--test-name-pattern",
        "flow",
        "--import",
        "tsx",
        "--loader",
        "custom-loader",
      ]),
      ["--import", "tsx", "--loader", "custom-loader"],
    );
  });

  for (const inspector of [
    "--inspect",
    "--inspect-brk",
    "--inspect-wait",
    "--inspect_brk",
    "--inspect_wait",
  ]) {
    for (const loader of ["--import", "--loader"]) {
      it(`keeps ${loader} and its value after bare ${inspector}`, () => {
        assert.deepEqual(
          sanitizeQueueOwnerExecArgv([inspector, loader, "fixture-module", "--trace-warnings"]),
          [loader, "fixture-module", "--trace-warnings"],
        );
      });
    }
  }

  it("drops debugger flags from queue-owner exec args", () => {
    assert.deepEqual(
      sanitizeQueueOwnerExecArgv([
        "--inspect=9228",
        "--inspect-brk=9229",
        "--inspect-wait=127.0.0.1:0",
        "--inspect_brk=0",
        "--inspect_wait=0",
        "--inspect-port",
        "9230",
        "--debug-port=9231",
        "--inspect-publish-uid",
        "stderr,http",
        "--import",
        "tsx",
      ]),
      ["--import", "tsx"],
    );
  });

  it("recognizes value-bearing inspector aliases without rewriting retained arguments", () => {
    assert.deepEqual(
      sanitizeQueueOwnerExecArgv([
        "--inspect_port",
        "0",
        "--inspect_publish-uid",
        "stderr,http",
        "--inspect-publish_uid=stderr,http",
        "--debug_port=0",
        "--import",
        "./loader_with_underscores.mjs",
        "--trace_warnings",
        "__inspect",
      ]),
      ["--import", "./loader_with_underscores.mjs", "--trace_warnings", "__inspect"],
    );
  });
});

describe("buildQueueOwnerArgOverride", () => {
  it("returns null when no loader args remain after sanitization", () => {
    assert.equal(
      buildQueueOwnerArgOverride("/tmp/cli.js", [
        "--experimental-test-coverage",
        "--test",
        "--test-name-pattern",
        "flow",
      ]),
      null,
    );
  });

  it("uses the normal entrypoint fallback for inspector-only arguments", () => {
    for (const inspector of ["--inspect", "--inspect-brk", "--inspect-wait", "--inspect_wait"]) {
      assert.equal(buildQueueOwnerArgOverride("/tmp/cli.js", [inspector]), null);
    }
  });

  it("keeps a preload before the owner entrypoint after a bare inspector flag", () => {
    for (const inspector of ["--inspect", "--inspect-brk", "--inspect-wait", "--inspect_wait"]) {
      assert.equal(
        buildQueueOwnerArgOverride("/tmp/cli.js", [inspector, "--import", "tsx"]),
        JSON.stringify(["--import", "tsx", "/tmp/cli.js", "__queue-owner"]),
      );
    }
  });

  it("returns a serialized override when loader args are required", () => {
    assert.equal(
      buildQueueOwnerArgOverride("/tmp/cli.js", ["--import", "tsx"]),
      JSON.stringify(["--import", "tsx", "/tmp/cli.js", "__queue-owner"]),
    );
  });
});

describe("queueOwnerRuntimeOptionsFromSend", () => {
  it("preserves client capability preferences", () => {
    const options = queueOwnerRuntimeOptionsFromSend({
      sessionId: "session-1",
      permissionMode: "approve-reads",
      fs: false,
      terminal: false,
    });

    assert.equal(options.fs, false);
    assert.equal(options.terminal, false);
  });
});

describe("queue owner startup exit classification", () => {
  it("keeps polling when a competing child loses the lease cleanly", () => {
    assert.equal(
      queueOwnerRuntimeTestInternals.queueOwnerExitIsFatal({
        exited: true,
        code: 0,
        signal: null,
      }),
      false,
    );
  });

  it("reports child startup failures", () => {
    assert.equal(
      queueOwnerRuntimeTestInternals.queueOwnerExitIsFatal({
        exited: true,
        code: 1,
        signal: null,
      }),
      true,
    );
    assert.equal(
      queueOwnerRuntimeTestInternals.queueOwnerExitIsFatal({
        exited: true,
        code: null,
        signal: "SIGTERM",
      }),
      true,
    );
  });
});

describe("session process command parsing", () => {
  it("reads quoted executable paths from saved agent commands", () => {
    assert.equal(
      sessionControlTestInternals.firstAgentCommandToken(
        '"/Applications/My Agent.app/Contents/MacOS/agent" --profile x',
      ),
      "/Applications/My Agent.app/Contents/MacOS/agent",
    );
  });

  it("preserves quoted executable paths in process-list fallbacks", () => {
    assert.deepEqual(
      sessionControlTestInternals.splitCommandLineLike(
        '"/Applications/My Agent.app/Contents/MacOS/agent" --profile "with spaces"',
      ),
      ["/Applications/My Agent.app/Contents/MacOS/agent", "--profile", "with spaces"],
    );
  });
});

describe("formatQueueOwnerStartupFailure", () => {
  it("includes exit code when the owner dies before bind", async () => {
    const { formatQueueOwnerStartupFailure } =
      await import("../src/session/execution/queue-owner-process.js");
    const message = formatQueueOwnerStartupFailure({
      sessionId: "sess-1",
      exit: { exited: true, code: 1, signal: null },
      logTail: "Error: EPERM: operation not permitted, chmod",
    });
    assert.match(message, /exited with code 1/);
    assert.match(message, /EPERM/);
    assert.match(message, /sess-1/);
  });

  it("includes spawn error when the process cannot start", async () => {
    const { formatQueueOwnerStartupFailure } =
      await import("../src/session/execution/queue-owner-process.js");
    const message = formatQueueOwnerStartupFailure({
      sessionId: "sess-2",
      exit: {
        exited: true,
        code: null,
        signal: null,
        spawnError: new Error("spawn ENOENT"),
      },
      logTail: "",
    });
    assert.match(message, /spawn error: spawn ENOENT/);
  });
});

describe("spawnQueueOwnerProcess startup capture lifecycle", () => {
  it("delivers large Unicode bootstrap input without writing temporary payloads", async () => {
    await withTempDir(async (directory) => {
      const previousArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = directory;
      process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
        "--input-type=module",
        "-e",
        `
        import { text } from "node:stream/consumers";
        import { createHash } from "node:crypto";
        await new Promise(resolve => setTimeout(resolve, 25));
        const payload = await text(process.stdin);
        JSON.parse(payload);
        process.stderr.write(createHash("sha256").update(payload).digest("hex"));
      `,
      ]);
      const options = {
        sessionId: "pipe-bootstrap",
        permissionMode: "approve-reads" as const,
        authCredentials: { synthetic: "fixture-🦞".repeat(128 * 1024) },
      };
      try {
        const handle = spawnQueueOwnerProcess(options);
        await waitForCondition(
          () => handle.getExitState().exited,
          "owner did not consume bootstrap input",
          5_000,
        );
        assert.equal(handle.getExitState().code, 0, handle.readLogTail());
        assert.equal(
          handle.readLogTail(),
          createHash("sha256").update(JSON.stringify(options)).digest("hex"),
        );
        assert.deepEqual(await fs.readdir(directory), []);
      } finally {
        if (previousArgs === undefined) {
          delete process.env.ACPX_QUEUE_OWNER_ARGS;
        } else {
          process.env.ACPX_QUEUE_OWNER_ARGS = previousArgs;
        }
        if (previousTmp === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previousTmp;
        }
      }
    });
  });

  it("keeps final stderr when the bootstrap pipe closes early", async () => {
    const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
      "-e",
      "require('node:fs').writeSync(2,'bootstrap-refused');process.exit(1)",
    ]);
    try {
      const handle = spawnQueueOwnerProcess({
        sessionId: "early-pipe-close",
        permissionMode: "approve-reads",
        authCredentials: { synthetic: "fixture".repeat(256 * 1024) },
      });
      await waitForCondition(() => handle.getExitState().exited, "owner did not finish early exit");
      assert.equal(handle.getExitState().code, 1);
      assert.match(handle.readLogTail(), /bootstrap-refused/);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previous;
      }
    }
  });

  it("lets the submitter exit while a detached owner keeps draining stderr", async () => {
    const { spawnSync } = await import("node:child_process");
    const moduleUrl = new URL("../src/session/execution/queue-owner-process.js", import.meta.url)
      .href;
    const brokenPipeModuleUrl = new URL("../src/cli/broken-pipe.js", import.meta.url).href;
    const ownerCode = `
      import { installBrokenPipeHandler } from ${JSON.stringify(brokenPipeModuleUrl)};
      installBrokenPipeHandler(process.stderr, "ignore");
      setInterval(() => process.stderr.write("owner-alive\\n"), 20);
    `;
    const ownerArgs = JSON.stringify(["--input-type=module", "-e", ownerCode]);
    const probe = `
      import { spawnQueueOwnerProcess } from ${JSON.stringify(moduleUrl)};
      process.env.ACPX_QUEUE_OWNER_ARGS = ${JSON.stringify(ownerArgs)};
      const handle = spawnQueueOwnerProcess({
        sessionId: "submitter-exit",
        permissionMode: "approve-reads",
      });
      handle.stopStartupCapture();
      console.log(handle.pid);
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const ownerPid = Number.parseInt(result.stdout.trim(), 10);
    try {
      assert.equal(
        result.status,
        0,
        `submitter did not exit independently: ${result.stderr || String(result.signal)}`,
      );
      assert.ok(Number.isInteger(ownerPid) && ownerPid > 0, "expected detached owner pid");
      assert.doesNotThrow(() => process.kill(ownerPid, 0), "owner should still be running");
    } finally {
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, "SIGTERM");
        } catch {
          // The assertion above reports an unexpectedly missing owner.
        }
      }
    }
  });

  it("captures early stderr then drains without killing owner after stop", async () => {
    const { spawnQueueOwnerProcess } =
      await import("../src/session/execution/queue-owner-process.js");

    const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
      "-e",
      "process.stderr.on('error',()=>{});process.stderr.write('startup-noise'+String.fromCharCode(10));setTimeout(()=>{const t=setInterval(()=>{try{process.stderr.write('post-bind-noise'+String.fromCharCode(10))}catch{}},20);setTimeout(()=>{clearInterval(t);process.exit(0);},300);},200);",
    ]);
    try {
      const handle = spawnQueueOwnerProcess({
        sessionId: "capture-lifecycle",
        permissionMode: "approve-reads",
      });
      await waitForCondition(
        () => handle.readLogTail().includes("startup-noise"),
        "owner did not emit startup diagnostics",
      );
      const duringStartup = handle.readLogTail();
      assert.match(duringStartup, /startup-noise/);
      assert.doesNotMatch(duringStartup, /post-bind-noise/);
      handle.stopStartupCapture();
      await waitForCondition(
        () => handle.getExitState().exited,
        "owner did not exit after post-bind writes",
      );
      const afterStop = handle.readLogTail();
      assert.equal(afterStop, duringStartup);
      assert.doesNotMatch(afterStop, /post-bind-noise/);
      const exit = handle.getExitState();
      assert.equal(exit.exited, true);
      assert.equal(exit.code, 0, `expected clean exit, got ${JSON.stringify(exit)}`);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previous;
      }
    }
  });

  it("bounds captured stderr to QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES", async () => {
    const { spawnQueueOwnerProcess, QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES } =
      await import("../src/session/execution/queue-owner-process.js");

    const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([
      "-e",
      "process.stderr.write('x'.repeat(20000) + 'FINAL-DIAGNOSTIC'); process.exit(1);",
    ]);
    try {
      const handle = spawnQueueOwnerProcess({
        sessionId: "capture-bound",
        permissionMode: "approve-reads",
      });
      await waitForCondition(
        () => handle.getExitState().exited,
        "owner did not exit after bounded diagnostic",
      );
      const tail = handle.readLogTail();
      assert.ok(tail.length <= QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES);
      assert.match(tail, /FINAL-DIAGNOSTIC$/);
      handle.stopStartupCapture();
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previous;
      }
    }
  });
});
