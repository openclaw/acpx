import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TimeoutError, withTimeout } from "../src/async-control.js";
import { settleQueueCase } from "./fixtures/queue-timeout-host.js";

const HOST = fileURLToPath(new URL("./fixtures/queue-timeout-host.js", import.meta.url));
const CASE_TIMEOUT_MS = 30_000;

function remainingCaseTime(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new TimeoutError(CASE_TIMEOUT_MS);
  }
  return remaining;
}

type QueueHostResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutEof: boolean;
  stderrEof: boolean;
};

type QueueHostPhases = {
  pid: number | undefined;
  spawned: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  stdoutEof: boolean;
  stderrEof: boolean;
  closeObserved: boolean;
  disconnected: boolean;
};

class QueueHostDeadlineError extends AggregateError {
  constructor(
    errors: unknown[],
    message: string,
    readonly completion: QueueHostResult | undefined,
    readonly phases: QueueHostPhases,
  ) {
    super(errors, message, { cause: errors[0] });
  }
}

async function runQueueHost(
  home: string,
  args: string[],
  options: {
    deadline?: number;
    timeoutMs?: number;
    waitForReady?: boolean;
    disconnectAfterReady?: boolean;
    expectedExitCode?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_") || key === "NODE_OPTIONS") {
      delete env[key];
    }
  }
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  assert.ok(stdoutStream && stderrStream, "queue host requires both owned output pipes");
  let stdout = "";
  let stderr = "";
  let stdoutEof = false;
  let stderrEof = false;
  let exited = false;
  let spawned = false;
  let exit: QueueHostPhases["exit"];
  let closeObserved = false;
  let disconnected = false;
  let childError: Error | undefined;
  const phases = (): QueueHostPhases => ({
    pid: child.pid,
    spawned,
    exit,
    stdoutEof,
    stderrEof,
    closeObserved,
    disconnected,
  });
  let finishCompletion!: () => void;
  // Parent-side IPC disconnect can omit ChildProcess.close despite native exit and both EOFs.
  const completed = new Promise<QueueHostResult>((resolve, reject) => {
    finishCompletion = () => {
      if (exit && stdoutEof && stderrEof) {
        resolve({ ...exit, stdoutEof, stderrEof });
      } else if (childError && child.pid === undefined && closeObserved) {
        reject(childError);
      }
    };
  });
  stdoutStream.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  stderrStream.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  stdoutStream.once("end", () => {
    stdoutEof = true;
    finishCompletion();
  });
  stderrStream.once("end", () => {
    stderrEof = true;
    finishCompletion();
  });
  child.once("spawn", () => {
    spawned = true;
  });
  child.once("exit", (code, signal) => {
    exited = true;
    exit = { code, signal };
    finishCompletion();
  });
  child.on("error", (error) => {
    childError = error;
    finishCompletion();
  });
  child.once("close", () => {
    closeObserved = true;
    finishCompletion();
  });
  child.once("disconnect", () => {
    disconnected = true;
  });
  const ready = new Promise<void>((resolve) => {
    child.on("message", (message: unknown) => {
      if (message === "ready") {
        resolve();
      }
    });
  });
  let result: Awaited<typeof completed>;
  try {
    if (options.waitForReady) {
      await withTimeout(
        Promise.race([
          ready,
          completed.then(() => {
            throw new Error("Queue host exited before readiness");
          }),
        ]),
        5_000,
      );
    }
    if (options.disconnectAfterReady) {
      child.disconnect();
    }
    result = await withTimeout(
      completed,
      options.deadline === undefined
        ? (options.timeoutMs ?? CASE_TIMEOUT_MS)
        : remainingCaseTime(options.deadline),
    );
    if (options.deadline !== undefined) {
      remainingCaseTime(options.deadline);
    }
  } catch (primary) {
    const errors = [primary];
    let completion: QueueHostResult | undefined;
    if (childError && child.pid === undefined && closeObserved) {
      throw new QueueHostDeadlineError(
        errors,
        `Queue host failed to spawn; fixture retained at ${home}`,
        undefined,
        phases(),
      );
    }
    // Only this case's host translates the IPC stop into its owner's local signal.
    try {
      if (child.connected) {
        child.send("stop", (error) => {
          if (error) {
            errors.push(error);
          }
        });
      } else if (!exited) {
        child.kill("SIGTERM");
      }
    } catch (stopError) {
      errors.push(stopError);
    }
    try {
      completion = await withTimeout(completed, 5_000);
    } catch (cleanupError) {
      errors.push(cleanupError);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          errors.push(killError);
        }
      }
      try {
        completion = await withTimeout(completed, 5_000);
      } catch (closeError) {
        errors.push(closeError);
        stdoutStream.destroy();
        stderrStream.destroy();
        child.channel?.unref();
        child.unref();
      }
    }
    throw new QueueHostDeadlineError(
      errors,
      `Queue host deadline failed; fixture retained at ${home}\n${stdout}\n${stderr}`,
      completion,
      phases(),
    );
  }
  if (childError) {
    throw new Error(`Queue host process error: ${JSON.stringify(phases())}`, { cause: childError });
  }
  assert.deepEqual(
    result,
    { code: options.expectedExitCode ?? 0, signal: null, stdoutEof: true, stderrEof: true },
    `${JSON.stringify(phases())}\n${stdout}\n${stderr}`,
  );
  return { stdout, stderr };
}

for (const mode of [
  "silent",
  "partial",
  "cooperative",
  "load-failure",
  "close-failure",
  "settled-close-failure",
  "stalled-cancel",
]) {
  test(
    `queue retires timed-out work before its successor: ${mode}`,
    // The original 30s success limit is unchanged; the extra time is failed cleanup only.
    { timeout: 45_000 },
    async () => {
      const deadline = performance.now() + CASE_TIMEOUT_MS;
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-queue-timeout-"));
      let removed = false;
      try {
        remainingCaseTime(deadline);
        await runQueueHost(home, [HOST, home, mode], { deadline });
        const result = JSON.parse(await fs.readFile(path.join(home, "result.json"), "utf8")) as {
          outcome: string;
        };
        remainingCaseTime(deadline);
        assert.equal(result.outcome, "passed");
        await fs.rm(home, { recursive: true, force: true });
        removed = true;
        remainingCaseTime(deadline);
      } catch (error) {
        // Failed or unjoined owners keep their fixed HOME, including after a rescue.
        throw new Error(
          removed
            ? `Queue timeout case failed after fixture removal: ${home}`
            : `Queue timeout fixture retained at ${home}`,
          { cause: error },
        );
      }
    },
  );
}

test("queue fixture preserves body and owner cleanup failures", async () => {
  const bodyError = new Error("body failure");
  const cleanupError = new Error("owner cleanup failure");
  await assert.rejects(
    settleQueueCase(
      async () => {
        throw bodyError;
      },
      Promise.reject(cleanupError),
      [],
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [bodyError, cleanupError]);
      assert.equal(error.cause, bodyError);
      return true;
    },
  );
});

test("queue fixture preserves its body error when joining the owner times out", async () => {
  const bodyError = new Error("body failure");
  let settleOwner!: () => void;
  const owner = new Promise<void>((resolve) => {
    settleOwner = resolve;
  });
  try {
    await assert.rejects(
      settleQueueCase(
        async () => {
          throw bodyError;
        },
        owner,
        [],
        1,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], bodyError);
        assert.ok(error.errors[1] instanceof TimeoutError);
        assert.equal(error.cause, bodyError);
        return true;
      },
    );
  } finally {
    settleOwner();
    await owner;
  }
});

test("queue fixture joins submitted work even when its body fails", async () => {
  const bodyError = new Error("body failure");
  let settleSubmission!: () => void;
  const submission = new Promise<void>((resolve) => {
    settleSubmission = resolve;
  });
  let returned = false;
  const run = settleQueueCase(
    async () => {
      throw bodyError;
    },
    Promise.resolve(),
    [submission],
  );
  void run.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, false, "fixture must still own the pending submission");
  } finally {
    settleSubmission();
    await run.catch(() => {});
  }
  await assert.rejects(run, (error: unknown) => error === bodyError);
});

test("queue fixture keeps a deadline failure after the host stops normally", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-queue-timeout-rescue-"));
  let joined = false;
  try {
    await assert.rejects(
      runQueueHost(
        home,
        [
          "--input-type=module",
          "-e",
          `
          import fs from 'node:fs';
          process.on('message', message => {
            if (message !== 'stop') return;
            fs.writeFileSync(process.env.HOME + '/stopped', 'stopped');
            clearInterval(held);
            process.disconnect();
          });
          const held = setInterval(() => {}, 1000);
          process.send('ready');
          `,
        ],
        { timeoutMs: 50, waitForReady: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof QueueHostDeadlineError);
        assert.deepEqual(error.completion, {
          code: 0,
          signal: null,
          stdoutEof: true,
          stderrEof: true,
        });
        joined = true;
        return true;
      },
    );
    assert.equal(await fs.readFile(path.join(home, "stopped"), "utf8"), "stopped");
  } finally {
    // This controlled host has no children. Unknown or failed retirement keeps its home.
    if (joined) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});

for (const cooperative of [true, false]) {
  test(`queue fixture fails after controller loss (cooperative: ${cooperative})`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-queue-controller-loss-"));
    let joined = false;
    try {
      const { stderr } = await runQueueHost(
        home,
        [
          "--input-type=module",
          "-e",
          `
        import fs from 'node:fs';
        import {guardQueueControllerLoss} from ${JSON.stringify(pathToFileURL(HOST).href)};
        const held = setInterval(() => {}, 1000);
        process.on('SIGTERM', () => {
          fs.writeFileSync(process.env.HOME + '/stop-requested', 'requested');
          if (${cooperative}) clearInterval(held);
        });
        guardQueueControllerLoss(() => process.emit('SIGTERM'), 50);
        process.send('ready');
      `,
        ],
        { waitForReady: true, disconnectAfterReady: true, expectedExitCode: 1 },
      );
      joined = true;
      assert.equal(await fs.readFile(path.join(home, "stop-requested"), "utf8"), "requested");
      if (cooperative) {
        assert.doesNotMatch(stderr, /forcing failed exit/);
      } else {
        assert.match(stderr, /Queue fixture cleanup did not settle; forcing failed exit/);
      }
    } finally {
      if (joined) {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  });
}

test("queue fixture failed finally keeps bounded shutdown after disconnect", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-queue-failed-finally-"));
  let joined = false;
  try {
    const { stderr } = await runQueueHost(home, [HOST, home, "fixture-cleanup-timeout"], {
      expectedExitCode: 1,
    });
    joined = true;
    assert.match(stderr, /Synthetic fixture body failure/);
    assert.match(stderr, /Timed out after 1ms/);
    assert.match(stderr, /Fixture failure control received stop/);
    assert.match(stderr, /Queue fixture cleanup did not settle; forcing failed exit/);
    const receipt = JSON.parse(await fs.readFile(path.join(home, "result.json"), "utf8")) as {
      outcome: string;
      detail: string;
    };
    assert.equal(receipt.outcome, "failed");
    assert.match(receipt.detail, /Synthetic fixture body failure/);
    assert.match(receipt.detail, /Timed out after 1ms/);
  } finally {
    // This control owns only an inert timer; verified host close ends all its activity.
    if (joined) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});
