/**
 * Tests that the queue owner runtime shuts down gracefully on SIGTERM/SIGINT,
 * so the codex-acp bridge adapter is never orphaned.
 *
 * See: src/session/execution/queue-owner-runtime.ts — the `runSessionQueueOwner`
 * function previously had no signal handlers; SIGTERM from lease-store's
 * terminateProcess() killed the Node process before the `finally` block could
 * run closeQueueOwnerRuntime(), leaving bridge adapters orphaned.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { observeProcessIncarnation, type ProcessBirthIdentity } from "../src/process-identity.js";
import { runSessionQueueOwner } from "../src/session/execution/queue-owner-runtime.js";
import { QueueLeaseGuardSettlementError } from "../src/session/queue/lease-mutation.js";
import { isProcessAlive } from "../src/session/queue/lease-store.js";
import { queueLockFilePath, queueSocketPath } from "../src/session/queue/paths.js";
import { extractAgentMessageChunkText } from "./jsonrpc-test-helpers.js";
import { verifiedProcessIdentity } from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 6_000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function connectQueueSocket(socketPath: string): Promise<net.Socket> {
  let connectedSocket: net.Socket | undefined;
  // A Unix socket file can exist before the server starts accepting connections.
  await waitUntil(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.setEncoding("utf8");
        socket.once("connect", () => {
          connectedSocket = socket;
          resolve(true);
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          socket.destroy();
          if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
            resolve(false);
          } else {
            reject(error);
          }
        });
      }),
  );
  assert(connectedSocket, "queue socket must be connected");
  return connectedSocket;
}

async function waitForBridgePid(pidFilePath: string): Promise<number> {
  let bridgePid = 0;
  // File creation precedes the PID write, so existence alone is not readiness.
  await waitUntil(async () => {
    if (!(await fileExists(pidFilePath))) {
      return false;
    }
    bridgePid = Number((await fs.readFile(pidFilePath, "utf8")).trim());
    return Number.isInteger(bridgePid) && bridgePid > 0;
  }, 8_000);
  return bridgePid;
}

async function waitForQueueMessage(
  iterator: AsyncIterator<string>,
  matches: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout waiting for queue message")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
      if (line.done) {
        throw new Error("queue socket closed before expected message");
      }
      const message = JSON.parse(line.value) as Record<string, unknown>;
      if (matches(message)) {
        return message;
      }
      assert.notEqual(message.type, "error", JSON.stringify(message));
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`Queue message not received within ${timeoutMs}ms`);
}

type ProcessClose = { code: number | null; signal: NodeJS.Signals | null };
type LifecycleOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function lifecycleOutcome<T>(run: () => Promise<T>): Promise<LifecycleOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function observeQueueProcess(child: ReturnType<typeof spawn>) {
  let stdout = "";
  let stderr = "";
  let stdoutEnded = child.stdout === null;
  let stderrEnded = child.stderr === null;
  let didClose = false;
  const errors: unknown[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.once("end", () => {
    stdoutEnded = true;
  });
  child.stderr?.once("end", () => {
    stderrEnded = true;
  });
  const closed = new Promise<ProcessClose>((resolve) => {
    child.once("close", (code, signal) => {
      didClose = true;
      resolve({ code, signal });
    });
  });
  const failed = new Promise<LifecycleOutcome<never>>((resolve) => {
    const recordError = (error: unknown) => {
      errors.push(error);
      resolve({ ok: false, error });
    };
    child.on("error", recordError);
    child.stdin?.on("error", recordError);
    child.stdout?.on("error", recordError);
    child.stderr?.on("error", recordError);
  });
  const outcome = Promise.race([closed.then((value) => ({ ok: true as const, value })), failed]);
  return {
    child,
    closed,
    outcome,
    errors,
    didClose: () => didClose,
    streamsEnded: () => stdoutEnded && stderrEnded,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

type ObservedQueueProcess = ReturnType<typeof observeQueueProcess>;

async function withinLifecycleDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string | (() => string) = "Lifecycle observation deadline elapsed",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(typeof message === "string" ? message : message())),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForProcessExit(
  owner: ObservedQueueProcess,
  timeoutMs = 8_000,
): Promise<ProcessClose> {
  const outcome = await withinLifecycleDeadline(
    owner.outcome,
    timeoutMs,
    () => `Queue owner process did not close within ${timeoutMs}ms; stderr=${owner.stderr()}`,
  );
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

type BridgeWitness = { pid: number; identity: ProcessBirthIdentity };

type BridgeControl = {
  path: string;
  pidFilePath: string;
  nonce: string;
  stopPath: string;
  cancelReceiptPath: string;
  leasePath: string;
};

async function withQueueOwnerHome(
  prefix: string,
  run: (
    homeDir: string,
    fixture: {
      spawn: (args: string[], input?: string) => ObservedQueueProcess;
      launchOwner: (record: ReturnType<typeof makeSessionRecord>) => Promise<ObservedQueueProcess>;
      socket: (socket: net.Socket) => net.Socket;
      lines: (socket: net.Socket) => readline.Interface;
      prepareBridge: (pidFilePath: string, leasePath: string) => Promise<BridgeControl>;
      observeBridge: () => Promise<BridgeWitness>;
      assertBridgeRetired: () => Promise<void>;
    },
  ) => Promise<void>,
  options: {
    removeHome?: (homeDir: string) => Promise<void>;
    retirementTimeoutMs?: number;
  } = {},
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  if (process.platform === "win32") {
    process.env.USERPROFILE = homeDir;
  }
  let owner: ObservedQueueProcess | undefined;
  let bridgeControl: BridgeControl | undefined;
  let bridge: BridgeWitness | undefined;
  const resources: Array<() => void> = [];
  const retirementTimeoutMs = options.retirementTimeoutMs ?? 5_000;
  const bridgeGone = async (timeoutMs = 1_000) => {
    assert(bridge, "bridge identity must be captured before shutdown");
    return (await observeProcessIncarnation(bridge.pid, bridge.identity, timeoutMs)) === "gone";
  };
  const spawnOwned = (args: string[], input?: string) => {
    assert.equal(owner, undefined, "one queue owner per fixture");
    owner = observeQueueProcess(
      spawn(process.execPath, args, {
        env: {
          ...process.env,
          HOME: homeDir,
          ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    assert(owner.child.stdin);
    owner.child.stdin.end(input);
    return owner;
  };
  try {
    const body = await lifecycleOutcome(() =>
      run(homeDir, {
        spawn: spawnOwned,
        async launchOwner(record) {
          await fs.mkdir(record.cwd, { recursive: true });
          await writeSessionRecordFile(homeDir, record);
          return spawnOwned(
            [CLI_PATH, "__queue-owner"],
            JSON.stringify({
              sessionId: record.acpxRecordId,
              permissionMode: "approve-reads",
            }),
          );
        },
        socket(socket) {
          resources.push(() => {
            socket.destroy();
          });
          return socket;
        },
        lines(socket) {
          const lines = readline.createInterface({ input: socket });
          resources.push(() => lines.close());
          return lines;
        },
        async prepareBridge(pidFilePath, leasePath) {
          assert.equal(bridgeControl, undefined);
          bridgeControl = {
            path: path.join(homeDir, "bridge-control.json"),
            pidFilePath,
            leasePath,
            nonce: randomUUID(),
            stopPath: path.join(homeDir, "bridge-stop"),
            cancelReceiptPath: path.join(homeDir, "cancel-observations.ndjson"),
          };
          await fs.writeFile(bridgeControl.path, JSON.stringify(bridgeControl));
          return bridgeControl;
        },
        async observeBridge() {
          assert(bridgeControl);
          const pid = await waitForBridgePid(bridgeControl.pidFilePath);
          bridge = { pid, identity: await verifiedProcessIdentity(pid) };
          return bridge;
        },
        async assertBridgeRetired() {
          assert.equal(
            await bridgeGone(),
            true,
            "original bridge must retire before graceful owner shutdown is accepted",
          );
        },
      }),
    );
    const cleanup = await lifecycleOutcome(async () => {
      const failures: unknown[] = [];
      let retired = true;
      for (const release of resources.toReversed()) {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (owner) {
        if (!owner.didClose()) {
          if (owner.child.exitCode === null && owner.child.signalCode === null) {
            try {
              assert(owner.child.kill("SIGKILL"), "owned owner rescue must be dispatched");
              if (body.ok) {
                failures.push(new Error("Successful body left an owner requiring rescue"));
              }
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            await withinLifecycleDeadline(
              owner.closed,
              retirementTimeoutMs,
              "Owned owner close remains unverified",
            );
          } catch (error) {
            retired = false;
            failures.push(error);
          }
        }
        for (const error of owner.errors) {
          if ((body.ok || error !== body.error) && !failures.includes(error)) {
            failures.push(error);
          }
        }
        if (bridgeControl) {
          try {
            if (!bridge || !(await bridgeGone())) {
              // Only the opted-in synthetic bridge consumes this nonce. Never signal its saved PID.
              await fs.writeFile(bridgeControl.stopPath, bridgeControl.nonce);
              if (body.ok) {
                failures.push(new Error("Successful body left a bridge requiring rescue"));
              }
              assert(bridge, "bridge birth was not captured; retirement is unverified");
              const deadline = performance.now() + retirementTimeoutMs;
              while (true) {
                const remaining = deadline - performance.now();
                assert(remaining > 0, "Original bridge retirement remains unverified");
                if (await bridgeGone(Math.max(1, Math.min(1_000, Math.floor(remaining))))) {
                  break;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
              }
            }
          } catch (error) {
            retired = false;
            failures.push(error);
          }
        }
      }
      if (retired) {
        try {
          await (
            options.removeHome ??
            ((directory) => fs.rm(directory, { recursive: true, force: true }))
          )(homeDir);
        } catch (error) {
          failures.push(error);
        }
      } else {
        failures.push(
          new Error(`Retained queue fixture HOME because retirement is unverified: ${homeDir}`),
        );
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `Queue fixture cleanup failed; HOME: ${homeDir}`);
      }
    });

    if (!body.ok && !cleanup.ok) {
      throw new AggregateError(
        [body.error, cleanup.error],
        "Queue fixture body and cleanup failed",
      );
    }
    if (!body.ok) {
      throw body.error;
    }
    if (!cleanup.ok) {
      throw cleanup.error;
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (process.platform === "win32") {
      if (originalProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalProfile;
      }
    }
  }
}

it(
  "queue lifecycle keeps a completed native close available to a late consumer",
  { timeout: 5_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('native-output'); process.stderr.write('native-error');"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const owner = observeQueueProcess(child);
    const independentlyClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      const native = await withinLifecycleDeadline(independentlyClosed, 2_000);
      assert.deepEqual(owner.errors, []);
      assert.deepEqual(native, { code: 0, signal: null });
      assert.equal(child.stdout.readableEnded && child.stderr.readableEnded, true);
      assert.equal(owner.stdout(), "native-output");
      assert.equal(owner.stderr(), "native-error");
      assert.deepEqual(await waitForProcessExit(owner, 50), native);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await withinLifecycleDeadline(independentlyClosed, 2_000);
    }
  },
);

function pipeHoldingChild(homeDir: string) {
  const readyPath = path.join(homeDir, "holder-ready");
  const releasePath = path.join(homeDir, "holder-release");
  const exitPath = path.join(homeDir, "holder-exit");
  const holder = `
    const fs = require("node:fs");
    const [ready, release, exit] = process.argv.slice(1);
    process.on("exit", (code) => fs.writeFileSync(exit, String(code)));
    const timer = setInterval(() => {
      if (fs.existsSync(release)) clearInterval(timer);
    }, 10);
    setTimeout(() => process.exit(94), 10_000).unref();
    fs.writeFileSync(ready, String(process.pid));
  `;
  const parent = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(holder)}, ...process.argv.slice(1)], {
      stdio: ["ignore", "inherit", "inherit"]
    }).unref();
    process.stdout.write("parent-output");
  `;
  return {
    readyPath,
    releasePath,
    exitPath,
    args: ["-e", parent, readyPath, releasePath, exitPath],
  };
}

for (const completion of ["released", "withheld"] as const) {
  it(
    `queue lifecycle ${completion === "released" ? "joins inherited pipes before home removal" : "retains its home until inherited pipes close"}`,
    { timeout: 15_000 },
    async () => {
      const failure = new Error("body failed while inherited pipes remained open");
      const originalHome = process.env.HOME;
      const originalProfile = process.env.USERPROFILE;
      const state: {
        homeDir?: string;
        owner?: ObservedQueueProcess;
        pipes?: ReturnType<typeof pipeHoldingChild>;
      } = {};
      let removalStarted = false;
      let reachedBody!: () => void;
      const bodyReached = new Promise<void>((resolve) => {
        reachedBody = resolve;
      });
      const running = withQueueOwnerHome(
        "acpx-lifecycle-pipes-",
        async (homeDir, fixture) => {
          state.homeDir = homeDir;
          state.pipes = pipeHoldingChild(homeDir);
          const owner = fixture.spawn(state.pipes.args);
          state.owner = owner;
          const exited = new Promise<ProcessClose>((resolve) =>
            owner.child.once("exit", (code, signal) => resolve({ code, signal })),
          );
          await waitUntil(() => fileExists(state.pipes!.readyPath), 2_000);
          assert.deepEqual(await withinLifecycleDeadline(exited, 2_000), { code: 0, signal: null });
          assert.equal(owner.didClose(), false);
          await assert.rejects(waitForProcessExit(owner, 25), /did not close within 25ms/u);
          assert.equal(
            owner.child.exitCode,
            0,
            "exit fields do not replace the pending close event",
          );
          reachedBody();
          throw failure;
        },
        {
          retirementTimeoutMs: completion === "withheld" ? 25 : 5_000,
          removeHome: async (homeDir) => {
            removalStarted = true;
            assert.equal(state.owner?.didClose(), true);
            assert.equal(state.owner?.streamsEnded(), true);
            assert.equal(await fs.readFile(state.pipes!.exitPath, "utf8"), "0");
            await fs.rm(homeDir, { recursive: true, force: true });
          },
        },
      );
      void running.catch(() => {});
      try {
        await withinLifecycleDeadline(Promise.race([bodyReached, running]), 4_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(removalStarted, false);
        assert.equal(state.owner?.didClose(), false);
        if (completion === "released") {
          await fs.writeFile(state.pipes!.releasePath, "release");
          await assert.rejects(running, (error) => error === failure);
          assert.equal(removalStarted, true);
          assert.equal(await fileExists(state.homeDir!), false);
        } else {
          await assert.rejects(running, (error) => {
            assert(error instanceof AggregateError);
            assert.equal(error.errors[0], failure);
            assert.match(String(error.errors[1]), /Queue fixture cleanup failed/u);
            return true;
          });
          assert.equal(removalStarted, false);
          assert.equal(await fileExists(state.homeDir!), true);
        }
        assert.equal(process.env.HOME, originalHome);
        assert.equal(process.env.USERPROFILE, originalProfile);
      } finally {
        if (state.homeDir && state.pipes && (await fileExists(state.homeDir))) {
          await fs.writeFile(state.pipes.releasePath, "release");
          if (state.owner) {
            await withinLifecycleDeadline(state.owner.closed, 5_000);
          }
          assert.equal(await fs.readFile(state.pipes.exitPath, "utf8"), "0");
          await fs.rm(state.homeDir, { recursive: true, force: true });
        }
        await running.catch(() => {});
      }
    },
  );
}

for (const removalFails of [false, true]) {
  it(`queue lifecycle preserves ${removalFails ? "body and removal failures" : "an undefined body rejection after native cleanup"}`, async () => {
    const failure = removalFails ? new Error("primary body failure") : undefined;
    const removalFailure = new Error("synthetic home removal failure");
    let fixtureHome: string | undefined;
    let owner: ObservedQueueProcess | undefined;
    try {
      await assert.rejects(
        withQueueOwnerHome(
          "acpx-lifecycle-failures-",
          async (homeDir, fixture) => {
            fixtureHome = homeDir;
            owner = fixture.spawn([
              "-e",
              "process.stdout.write('ready'); setInterval(() => {}, 1000);",
            ]);
            await waitUntil(async () => owner!.stdout() === "ready", 2_000);
            throw failure;
          },
          {
            removeHome: async (homeDir) => {
              assert.equal(owner?.didClose(), true);
              assert.equal(owner?.streamsEnded(), true);
              if (removalFails) {
                throw removalFailure;
              }
              await fs.rm(homeDir, { recursive: true, force: true });
            },
          },
        ),
        (error) => {
          if (removalFails) {
            assert(error instanceof AggregateError);
            assert.deepEqual(error.errors, [failure, removalFailure]);
          } else {
            assert.equal(error, undefined);
          }
          return true;
        },
      );
      assert.equal(owner?.didClose(), true);
      assert.equal(owner?.streamsEnded(), true);
      assert.equal(await fileExists(fixtureHome!), removalFails);
    } finally {
      if (fixtureHome && owner?.didClose()) {
        await fs.rm(fixtureHome, { recursive: true, force: true });
      }
    }
  });
}

it("queue lifecycle records an early spawn error and still joins close", async () => {
  const owner = observeQueueProcess(
    spawn(path.join(os.tmpdir(), `missing-owner-${randomUUID()}`), [], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  await assert.rejects(waitForProcessExit(owner, 2_000), { code: "ENOENT" });
  await withinLifecycleDeadline(owner.closed, 2_000);
  assert.equal(owner.didClose(), true);
  assert.equal(owner.child.pid, undefined);
});

it("queue lifecycle does not use owner close as a missing bridge retirement witness", async () => {
  const failure = new Error("bridge readiness was never observed");
  let fixtureHome: string | undefined;
  let removals = 0;
  try {
    await assert.rejects(
      withQueueOwnerHome(
        "acpx-lifecycle-no-bridge-witness-",
        async (homeDir, fixture) => {
          fixtureHome = homeDir;
          await fixture.prepareBridge(
            path.join(homeDir, "missing.pid"),
            path.join(homeDir, "lease"),
          );
          const owner = fixture.spawn(["-e", "process.stdout.write('closed');"]);
          await waitForProcessExit(owner);
          assert.equal(owner.streamsEnded(), true);
          throw failure;
        },
        {
          removeHome: async () => {
            removals += 1;
          },
        },
      ),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        return true;
      },
    );
    assert.equal(removals, 0);
    assert.equal(await fileExists(fixtureHome!), true);
  } finally {
    // This control never launches a bridge; its sole native child already joined close.
    if (fixtureHome) {
      await fs.rm(fixtureHome, { recursive: true, force: true });
    }
  }
});

describe("queue owner lifecycle — graceful SIGTERM shutdown", () => {
  for (const failureAt of ["initial", "interval", "queue-depth"] as const) {
    it(
      `settles ${failureAt} heartbeat guard failure after closing the server`,
      { timeout: 15000 },
      async (t) => {
        await withTempHome("acpx-lifecycle-guard-", async (homeDir) => {
          const cwd = path.join(homeDir, "workspace");
          await fs.mkdir(cwd, { recursive: true });
          const record = makeSessionRecord({
            acpxRecordId: `guard-${failureAt}`,
            acpSessionId: `guard-native-${failureAt}`,
            agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
            cwd,
          });
          await writeSessionRecordFile(homeDir, record);
          const lockPath = queueLockFilePath(record.acpxRecordId);
          const socketPath = queueSocketPath(record.acpxRecordId);
          let releases = 0;
          const rm = fs.rm;
          t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
            if (String(args[0]).endsWith(`${path.basename(lockPath)}.guard`)) {
              releases += 1;
              if (releases === (failureAt === "initial" ? 2 : 3)) {
                throw new Error("owner heartbeat release failed");
              }
            }
            return await rm(...args);
          });
          let serverClosed = false;
          const close = net.Server.prototype.close;
          t.mock.method(
            net.Server.prototype,
            "close",
            function (this: net.Server, callback?: (error?: Error) => void) {
              return close.call(this, (error?: Error) => {
                serverClosed = true;
                callback?.(error);
              });
            },
          );
          const unlink = fs.unlink;
          let removedLease = false;
          t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
            if (String(args[0]).endsWith(path.basename(lockPath))) {
              assert.equal(serverClosed, true, "server close callback must precede lease release");
              removedLease = true;
            }
            return await unlink(...args);
          });
          const running = assert.rejects(
            runSessionQueueOwner({
              sessionId: record.acpxRecordId,
              permissionMode: "approve-reads",
              ttlMs: 0,
            }),
            QueueLeaseGuardSettlementError,
          );
          let socket: net.Socket | undefined;
          try {
            if (failureAt === "queue-depth") {
              await waitUntil(async () => releases >= 2);
              socket = await connectQueueSocket(socketPath);
              socket.on("error", () => {});
              socket.resume();
              socket.write(
                `${JSON.stringify({ type: "submit_prompt", requestId: "guard-failure", message: "sleep 10000", permissionMode: "approve-reads", waitForCompletion: true })}\n`,
              );
            }
            await running;
            assert.equal(serverClosed, true);
            assert.equal(removedLease, true);
            assert.equal(await fileExists(lockPath), false);
            assert.equal(await fileExists(`${lockPath}.guard`), false);
          } finally {
            socket?.destroy();
          }
        });
      },
    );
  }

  it("releases its lease when session setup fails before the socket starts", async () => {
    await withTempHome("acpx-lifecycle-setup-", async (homeDir) => {
      const sessionId = "missing-owner-session";
      await assert.rejects(runSessionQueueOwner({ sessionId, permissionMode: "approve-reads" }));
      assert.equal(await fileExists(queueLockFilePath(sessionId, homeDir)), false);
    });
  });

  it("exits with code 0 and releases its lease when it receives SIGTERM", async () => {
    if (process.platform === "win32") {
      // SIGTERM semantics differ on Windows; skip this test.
      return;
    }

    await withQueueOwnerHome("acpx-lifecycle-sigterm-", async (homeDir, fixture) => {
      const cwd = path.join(homeDir, "workspace");

      // A minimal session record — the queue owner reads it during startup.
      // The agent bridge is only spawned when the first prompt is run, so
      // we just need any plausible agentCommand to pass startup validation.
      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-sigterm-test",
        acpSessionId: "lifecycle-sigterm-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });

      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      // Waiting for the socket avoids signaling before startup installs the
      // queue-owner process handlers.
      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const owner = await fixture.launchOwner(record);
      const child = owner.child;

      // Wait until the queue owner has created its Unix socket and entered
      // the idle task loop.
      await waitUntil(() => fileExists(socketPath));

      // Confirm the lock file is present before sending the signal.
      assert.equal(await fileExists(lockPath), true, "lock file must exist before SIGTERM");

      // Signal graceful shutdown.
      child.kill("SIGTERM");

      const { code, signal } = await waitForProcessExit(owner);
      const stderr = owner.stderr();

      // Graceful shutdown: exit code 0, not killed by a signal.
      assert.equal(
        signal,
        null,
        `process should not have been killed by a signal; stderr=${stderr}`,
      );
      assert.equal(code, 0, `expected exit code 0 (graceful); stderr=${stderr}`);

      // The lease must have been released: no orphaned lock file.
      assert.equal(
        await fileExists(lockPath),
        false,
        "lock file must be gone after graceful shutdown — lease was not released",
      );
    });
  });

  it("exits with code 0 and releases its lease when it receives SIGINT", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withQueueOwnerHome("acpx-lifecycle-sigint-", async (homeDir, fixture) => {
      const cwd = path.join(homeDir, "workspace");

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-sigint-test",
        acpSessionId: "lifecycle-sigint-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });

      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const owner = await fixture.launchOwner(record);
      const child = owner.child;

      // Wait for the socket — signal handlers are live at this point.
      await waitUntil(() => fileExists(socketPath));

      child.kill("SIGINT");

      const { code, signal } = await waitForProcessExit(owner);
      const stderr = owner.stderr();

      assert.equal(
        signal,
        null,
        `process should not have been killed by a signal; stderr=${stderr}`,
      );
      assert.equal(code, 0, `expected exit code 0 (graceful); stderr=${stderr}`);

      assert.equal(
        await fileExists(lockPath),
        false,
        "lock file must be gone after graceful shutdown — lease was not released",
      );
    });
  });

  it("does not let an idle IPC socket block SIGTERM shutdown or lease release", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withQueueOwnerHome("acpx-lifecycle-idle-socket-", async (homeDir, fixture) => {
      const cwd = path.join(homeDir, "workspace");

      const record = makeSessionRecord({
        acpxRecordId: "lifecycle-idle-socket-test",
        acpSessionId: "lifecycle-idle-socket-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      });

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);
      const lockPath = queueLockFilePath(record.acpxRecordId, homeDir);
      const owner = await fixture.launchOwner(record);
      const child = owner.child;

      await waitUntil(() => fileExists(socketPath));
      fixture.socket(await connectQueueSocket(socketPath));

      child.kill("SIGTERM");
      const { code, signal } = await waitForProcessExit(owner, 5_000);
      const stderr = owner.stderr();

      assert.equal(signal, null, `queue owner should exit gracefully; stderr=${stderr}`);
      assert.equal(code, 0, `expected queue owner exit code 0; stderr=${stderr}`);
      assert.equal(await fileExists(lockPath), false, "lease must be released after shutdown");
    });
  });
});

describe("queue owner lifecycle — bridge process death on SIGTERM", () => {
  it(
    "preserves a body failure after cooperatively retiring the verified bridge",
    {
      skip: process.platform === "win32",
      timeout: 20_000,
    },
    async (t) => {
      const failure = new Error("synthetic failure after prompt readiness");
      const state: {
        homeDir?: string;
        owner?: ObservedQueueProcess;
        control?: BridgeControl;
        bridge?: BridgeWitness;
      } = {};
      t.after(async () => {
        if (!state.homeDir || !(await fileExists(state.homeDir))) {
          return;
        }
        assert.equal(
          state.owner?.didClose(),
          true,
          "retain the home until the owned child has closed",
        );
        assert(state.bridge, "retain the home without a bridge birth witness");
        assert.equal(
          await observeProcessIncarnation(state.bridge.pid, state.bridge.identity),
          "gone",
        );
        await fs.rm(state.homeDir, { recursive: true, force: true });
      });
      await assert.rejects(
        withQueueOwnerHome(
          "acpx-lifecycle-bridge-rescue-",
          async (homeDir, fixture) => {
            state.homeDir = homeDir;
            const recordId = "lifecycle-rescue";
            const pidPath = path.join(homeDir, "bridge.pid");
            const control = await fixture.prepareBridge(
              pidPath,
              queueLockFilePath(recordId, homeDir),
            );
            state.control = control;
            const record = makeSessionRecord({
              acpxRecordId: recordId,
              acpSessionId: "lifecycle-rescue-native",
              cwd: homeDir,
              agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --pid-file ${JSON.stringify(pidPath)} --queue-lifecycle-control ${JSON.stringify(control.path)}`,
            });
            state.owner = await fixture.launchOwner(record);
            const socketPath = queueSocketPath(recordId, homeDir);
            await waitUntil(() => fileExists(socketPath));
            const socket = fixture.socket(await connectQueueSocket(socketPath));
            const lines = fixture.lines(socket);
            const iter = lines[Symbol.asyncIterator]();
            socket.write(
              `${JSON.stringify({ type: "submit_prompt", requestId: "rescue", message: "stream-sleep 10000 prompt-ready", permissionMode: "approve-reads", waitForCompletion: true })}\n`,
            );
            assert.equal((await waitForQueueMessage(iter, () => true)).type, "accepted");
            state.bridge = await fixture.observeBridge();
            await waitForQueueMessage(
              iter,
              (message) =>
                message.type === "event" &&
                extractAgentMessageChunkText(message.message as Record<string, unknown>) ===
                  "prompt-ready",
            );
            throw failure;
          },
          {
            removeHome: async (homeDir) => {
              assert(state.control);
              assert(state.bridge);
              assert.equal(state.owner?.didClose(), true);
              assert.deepEqual(
                JSON.parse(await fs.readFile(`${state.control.stopPath}.ack`, "utf8")),
                {
                  nonce: state.control.nonce,
                  pid: state.bridge.pid,
                },
              );
              await fs.rm(homeDir, { recursive: true, force: true });
            },
          },
        ),
        (error) => error === failure,
      );
      assert.equal(state.owner?.streamsEnded(), true);
      assert.equal(await fileExists(state.homeDir!), false);
    },
  );

  // Verifies that when the queue owner is SIGTERMed while a prompt is in
  // flight, the agent bridge process (mock-agent) is also killed by the
  // queue owner's graceful shutdown before it exits.
  //
  // This test catches the race that existed before the SIGTERM grace-period
  // fix: terminateProcess() used a 1 500 ms SIGTERM grace, but AcpClient.close()
  // can take up to ~2 600 ms.  With the old grace the queue owner could be
  // SIGKILLed before it finished killing the bridge, leaving it orphaned.
  it("kills the agent bridge when the queue owner receives SIGTERM mid-prompt", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withQueueOwnerHome("acpx-lifecycle-bridge-", async (homeDir, fixture) => {
      const cwd = path.join(homeDir, "workspace");

      // PID file: mock-agent writes its PID here as soon as it starts, before
      // the ACP handshake.  We poll for it to know the bridge is live.
      const pidFilePath = path.join(homeDir, "mock-agent.pid");
      const recordId = "lifecycle-bridge-test";
      const lockPath = queueLockFilePath(recordId, homeDir);
      const bridgeControl = await fixture.prepareBridge(pidFilePath, lockPath);

      const record = makeSessionRecord({
        acpxRecordId: recordId,
        acpSessionId: "lifecycle-bridge-session",
        // Pass --pid-file so the bridge records its PID at startup.
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --pid-file ${JSON.stringify(pidFilePath)} --queue-lifecycle-control ${JSON.stringify(bridgeControl.path)}`,
        cwd,
      });

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const owner = await fixture.launchOwner(record);
      const child = owner.child;

      let queueSocket: net.Socket | undefined;

      // Wait for the queue owner socket — signal handlers are live at this point.
      await waitUntil(() => fileExists(socketPath));

      // Connect to the queue-owner socket and submit a long-running prompt.
      // "sleep 10000" keeps the bridge busy for 10 s so it is still alive
      // when we send SIGTERM to the queue owner.
      queueSocket = fixture.socket(await connectQueueSocket(socketPath));

      queueSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-bridge-test",
          message: "sleep 10000",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      // Read the "accepted" acknowledgement.
      const lines = fixture.lines(queueSocket);
      const iter = lines[Symbol.asyncIterator]();
      const accepted = await waitForQueueMessage(iter, () => true);
      assert.equal(accepted.type, "accepted", "queue owner must acknowledge the prompt");

      // Close the readline and socket before sending SIGTERM.
      // (This was previously required to prevent a deadlock — server.close()
      // waited for connected sockets to drain — but is now just one of two
      // test scenarios; the companion test verifies the fix when the socket
      // stays open.)
      lines.close();
      queueSocket.destroy();
      queueSocket = undefined;

      // Wait for the bridge to write its PID — this confirms the bridge
      // process has been spawned and the ACP handshake has started.
      const { pid: bridgePid } = await fixture.observeBridge();
      assert(Number.isInteger(bridgePid) && bridgePid > 0, "bridge PID must be a positive integer");
      assert.equal(isProcessAlive(bridgePid), true, "bridge must be alive before SIGTERM");

      // Signal the queue owner to shut down gracefully.
      child.kill("SIGTERM");

      const { code, signal } = await waitForProcessExit(owner, 10_000);
      const stderr = owner.stderr();

      assert.equal(
        signal,
        null,
        `queue owner should not have been killed by a signal; stderr=${stderr}`,
      );
      assert.equal(code, 0, `expected queue owner exit code 0 (graceful); stderr=${stderr}`);

      // After the queue owner exits, the bridge must also be dead.
      // AcpClient.close() kills the bridge before releasing the lease.
      await fixture.assertBridgeRetired();
    });
  });

  it("drains the active turn before releasing its lease on SIGTERM", async () => {
    // Regression test for the connected-client deadlock.
    //
    // Before the fix:
    //   closeQueueOwnerRuntime called owner.close() first, which called
    //   server.close().  server.close() waits for all existing connections to
    //   drain.  A client in waitForCompletion that never closed its socket
    //   kept the drain blocked past the external SIGTERM grace period;
    //   terminateProcess() then SIGKILLed the owner before sharedClient.close()
    //   ran — leaving the bridge orphaned.
    //
    // After the fix, the owner stops admission, cancels and drains the active
    // turn while retaining its lease, then kills the bridge and drains IPC.
    if (process.platform === "win32") {
      return;
    }

    await withQueueOwnerHome("acpx-lifecycle-bridge-open-socket-", async (homeDir, fixture) => {
      const cwd = path.join(homeDir, "workspace");

      const pidFilePath = path.join(homeDir, "mock-agent-open.pid");
      const recordId = "lifecycle-bridge-open-socket-test";
      const lockPath = queueLockFilePath(recordId, homeDir);
      const bridgeControl = await fixture.prepareBridge(pidFilePath, lockPath);

      const record = makeSessionRecord({
        acpxRecordId: recordId,
        acpSessionId: "lifecycle-bridge-open-socket-session",
        agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --pid-file ${JSON.stringify(pidFilePath)} --queue-lifecycle-control ${JSON.stringify(bridgeControl.path)} --cancel-delay-ms 500`,
        cwd,
      });

      const socketPath = queueSocketPath(record.acpxRecordId, homeDir);

      const owner = await fixture.launchOwner(record);
      const child = owner.child;

      // This socket intentionally stays open (not destroyed before SIGTERM)
      // to reproduce the deadlock that existed before the fix.
      let queueSocket: net.Socket | undefined;

      await waitUntil(() => fileExists(socketPath));

      queueSocket = fixture.socket(await connectQueueSocket(socketPath));

      queueSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-open-socket-test",
          message: "stream-sleep 10000 prompt-ready",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      // Read the "accepted" acknowledgement.
      const lines = fixture.lines(queueSocket);
      const iter = lines[Symbol.asyncIterator]();
      const accepted = await waitForQueueMessage(iter, () => true);
      assert.equal(accepted.type, "accepted", "queue owner must acknowledge the prompt");

      // Deliberately do NOT close the readline or socket here.
      // The fix must handle this — the socket remaining open must not block
      // the bridge kill or prevent the owner from exiting within the grace period.

      // Wait until the bridge has written its PID — ACP handshake started.
      const { pid: bridgePid } = await fixture.observeBridge();
      assert(Number.isInteger(bridgePid) && bridgePid > 0, "bridge PID must be a positive integer");
      assert.equal(isProcessAlive(bridgePid), true, "bridge must be alive before SIGTERM");

      // A PID only proves process startup, not an active ACP prompt.
      await waitForQueueMessage(
        iter,
        (message) =>
          message.type === "event" &&
          extractAgentMessageChunkText(message.message as Record<string, unknown>) ===
            "prompt-ready",
      );

      const leaseBefore: { pid: number; ownerGeneration: number } = JSON.parse(
        await fs.readFile(lockPath, "utf8"),
      );
      assert.equal(leaseBefore.pid, child.pid);
      assert(Number.isSafeInteger(leaseBefore.ownerGeneration));
      const expectedLease = { pid: child.pid, ownerGeneration: leaseBefore.ownerGeneration };
      child.kill("SIGTERM");

      const terminalMessage = await waitForQueueMessage(
        iter,
        (message) => message.type === "result" || message.type === "error",
      );
      assert.equal(terminalMessage.type, "result", JSON.stringify(terminalMessage));
      const clientResult = terminalMessage.result as { stopReason?: unknown };
      assert.equal(clientResult.stopReason, "cancelled");

      // Keep the existing outcome budget while the client socket remains connected.
      const { code, signal } = await waitForProcessExit(owner, 8_000);
      const stderr = owner.stderr();

      assert.equal(
        signal,
        null,
        `queue owner should not have been killed by a signal — it likely stalled past the grace period; stderr=${stderr}`,
      );
      assert.equal(code, 0, `expected queue owner exit code 0 (graceful); stderr=${stderr}`);

      // Bridge must be dead — it must not have been orphaned.
      await fixture.assertBridgeRetired();

      // Lock file must be released.
      const leaseReleased = !(await fileExists(lockPath));
      assert.equal(leaseReleased, true, "lock file must be gone after graceful shutdown");

      const cancellationObservations = (await fs.readFile(bridgeControl.cancelReceiptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { lease: unknown });
      assert.deepEqual(
        cancellationObservations,
        [
          {
            nonce: bridgeControl.nonce,
            pid: bridgePid,
            phase: "entry",
            lease: expectedLease,
            promptPending: true,
            promptAborted: false,
          },
          {
            nonce: bridgeControl.nonce,
            pid: bridgePid,
            phase: "before-result",
            lease: expectedLease,
            promptPending: true,
            promptAborted: true,
          },
        ],
        "the same owner generation must hold the lease at cancel entry and before its result",
      );
      const leaseHeldDuringCancel = cancellationObservations.every(
        (observation) => observation.lease !== null,
      );

      if (process.env.ACPX_TEST_LIFECYCLE_TRACE === "1") {
        process.stdout.write(
          `ACPX_LIFECYCLE_PROOF ${JSON.stringify({
            ownerPid: child.pid,
            ownerExitCode: code,
            ownerSignal: signal,
            bridgePid,
            bridgeAliveAfter: isProcessAlive(bridgePid),
            leaseHeldDuringCancel,
            cancellationObservations,
            leaseReleased,
            clientType: terminalMessage.type,
            clientStopReason: clientResult.stopReason,
          })}\n`,
        );
      }

      lines.close();
    });
  });
});
