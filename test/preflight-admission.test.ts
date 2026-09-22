import assert from "node:assert/strict";
import { ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AcpClient } from "../src/acp/client.js";
import { captureCommandProbeOutput } from "../src/acp/command-probe.js";
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from "../src/runtime.js";
import type {
  AcpClientOptions,
  AcpProcessLaunch,
  AcpProcessLifecycle,
  AcpProcessStarted,
  AcpProcessExit,
} from "../src/types.js";
import type {
  DriverResult,
  FixtureConfig,
  PeerProfile,
  PeerTrace,
} from "./fixtures/preflight-context.js";

const peerPath = fileURLToPath(new URL("./fixtures/preflight-context.js", import.meta.url));
const runFile = promisify(execFile);
const native = { skip: process.platform === "win32", timeout: 15_000 };
const modern: PeerProfile = { version: "0.33.0", flag: "--acp" };
const old: PeerProfile = { version: "0.32.9", flag: "--experimental-acp" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("settled probe streams keep late destruction errors handled", async () => {
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let retirements = 0;
  const capture = captureCommandProbeOutput(child, 1_000, async () => {
    retirements += 1;
  });
  try {
    child.stdout.write("0.33.0");
    child.stderr.write("synthetic warning");
    child.emit("close", 0, null);
    assert.equal(await capture.result, "0.33.0\nsynthetic warning");
    capture.dispose();
    for (const stream of [child, child.stdout, child.stderr]) {
      assert.doesNotThrow(() => stream.emit("error", new Error("late stream destruction")));
    }
    assert.equal(retirements, 0);
  } finally {
    capture.dispose();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await delay(10);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function fixture(
  t: TestContext,
  profile: PeerProfile = modern,
  agent: "gemini" | "copilot" = "gemini",
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acpx-admission-")));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const command = path.join(bin, agent);
  const configPath = path.join(root, "config.json");
  const config: FixtureConfig = {
    root,
    agent,
    sessionEnv: {},
    profiles: { parent: profile, session: profile },
    cleanupToken: randomUUID(),
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(
    command,
    `#!/bin/sh\nexec ${[process.execPath, peerPath, "peer", configPath, "session"].map(quote).join(" ")} "$@"\n`,
    { mode: 0o755 },
  );
  const options: AcpClientOptions = {
    agentCommand: command,
    agentArgv: [command, "--acp", ...(agent === "copilot" ? ["--stdio"] : [])],
    cwd: root,
    permissionMode: "deny-all",
    agentProcessEnv: { GEMINI_API_KEY: "synthetic-not-a-provider-key" },
    processLaunchScope: { kind: "runtime-session", sessionKey: "admission-fixture" },
  };
  const clients: AcpClient[] = [];
  const readTrace = async (): Promise<PeerTrace[]> => {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(root, "trace.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PeerTrace);
  };
  t.after(async () => {
    const closeResults = await Promise.allSettled(clients.map((client) => client.close()));
    // This cooperative, nonce-bound fixture command never signals a numeric PID.
    // Product cleanup is asserted before teardown; needing this rescue fails the test.
    await fs.writeFile(path.join(root, "fixture-stop"), config.cleanupToken!);
    if (profile.probeBehavior === "inherited-pipes") {
      await waitUntil(
        async () => (await readTrace()).some((entry) => entry.event === "descendant"),
        "descendant receipt missing; keep the stop file/root for diagnosis",
      );
    }
    const peers = (await readTrace()).filter(
      (entry) => entry.event === "invocation" || entry.event === "descendant",
    );
    for (const peer of peers) {
      await waitUntil(
        () => !isRunning(peer.pid),
        "fixture peer did not retire after scoped cleanup",
      );
    }
    const rescued = (await readTrace()).filter(
      (entry) => entry.event === "fixture-cleanup" || entry.event === "safety-deadline",
    );
    if (rescued.length) {
      t.diagnostic(
        `fixture rescue/expiry, never product proof: ${rescued.map((entry) => `${entry.event}:${entry.pid}`).join(", ")}`,
      );
    }
    await fs.rm(root, { recursive: true, force: true });
    assert.equal(
      rescued.length,
      0,
      "fixture rescue/expiry was required after the product cleanup assertion",
    );
    assert.equal(
      closeResults.some((result) => result.status === "rejected"),
      false,
      "client teardown rejected",
    );
  });
  return {
    root,
    command,
    options,
    config,
    configPath,
    client: (processLifecycle: AcpProcessLifecycle) => {
      const client = new AcpClient({ ...options, processLifecycle });
      clients.push(client);
      return client;
    },
    trace: readTrace,
  };
}

async function expectEntered(starting: Promise<unknown>, entered: Promise<unknown>) {
  assert.equal(
    await Promise.race([
      entered.then(() => "entered"),
      starting.then(
        () => "finished",
        () => "finished",
      ),
    ]),
    "entered",
    "the compatibility admission hook was bypassed",
  );
}

for (const agent of ["gemini", "copilot"] as const) {
  test(`${agent} denied compatibility admission starts no executable`, native, async (t) => {
    const f = await fixture(t, modern, agent);
    const denial = new Error("synthetic admission denied");
    const before: AcpProcessLaunch[] = [];
    const client = f.client({
      onBeforeSpawn: (launch) => {
        before.push(launch);
        throw denial;
      },
      onSpawned: () => assert.fail("denied probe must not spawn"),
      onSpawnFailed: () => assert.fail("denial is not an OS spawn failure"),
    });
    await assert.rejects(client.start(), (error) => error === denial);
    assert.equal(before.length, 1);
    assert.deepEqual(before[0]?.args, [agent === "gemini" ? "--version" : "--help"]);
    assert.deepEqual(await f.trace(), []);
  });
}

test("held pre-spawn probe admission has no side effect before release", native, async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const release = deferred<void>();
  const client = f.client({
    onBeforeSpawn: async (launch) => {
      if (launch.args.includes("--version")) {
        entered.resolve(undefined);
        await release.promise;
      }
    },
  });
  const starting = client.start();
  void starting.catch(() => {});
  try {
    await expectEntered(starting, entered.promise);
    assert.deepEqual(await f.trace(), []);
    release.resolve(undefined);
    await starting;
    assert.deepEqual(
      (await f.trace()).map((entry) => entry.args[0]),
      ["--version", "--acp"],
    );
  } finally {
    release.resolve(undefined);
    await starting.catch(() => {});
  }
});

test(
  "fast probe exit waits for spawned admission without becoming an ACP failure",
  native,
  async (t) => {
    const f = await fixture(t, old);
    const entered = deferred<number>();
    const release = deferred<void>();
    const before: AcpProcessLaunch[] = [];
    const started: AcpProcessStarted[] = [];
    const exits: AcpProcessExit[] = [];
    const client = f.client({
      onBeforeSpawn: (launch) => {
        assert(
          Object.isFrozen(launch) && Object.isFrozen(launch.args) && Object.isFrozen(launch.scope),
        );
        assert.deepEqual(launch.scope, {
          kind: "runtime-session",
          sessionKey: "admission-fixture",
        });
        before.push(launch);
      },
      onSpawned: async (event) => {
        started.push(event);
        if (event.args.includes("--version")) {
          entered.resolve(event.pid);
          await release.promise;
        }
      },
      onExit: (event) => {
        exits.push(event);
        throw new Error("synthetic best-effort observer error");
      },
    });
    const starting = client.start();
    void starting.catch(() => {});
    try {
      await expectEntered(starting, entered.promise);
      const pid = await entered.promise;
      await waitUntil(() => !isRunning(pid), "fast version child did not exit");
      assert.equal(exits.length, 0, "exit escaped its admission barrier");
      release.resolve(undefined);
      await starting;
      await client.close();
      await waitUntil(() => exits.length === 2, "missing paired exits");
      assert.deepEqual(
        before.map((event) => event.args[0]),
        ["--version", "--experimental-acp"],
      );
      assert.equal(new Set(before.map((event) => event.launchId)).size, 2);
      for (const event of started) {
        assert(Object.isFrozen(event));
        assert.deepEqual(before.find((item) => item.launchId === event.launchId)?.args, event.args);
        assert.equal(
          exits.filter((item) => item.launchId === event.launchId && item.pid === event.pid).length,
          1,
        );
      }
    } finally {
      release.resolve(undefined);
      await starting.catch(() => {});
    }
  },
);

test(
  "rejected spawned probe admission retires the live probe before rejecting",
  native,
  async (t) => {
    const f = await fixture(t, { ...modern, probeBehavior: "hold" });
    const denial = new Error("synthetic spawned admission denied");
    let pid = 0;
    const exits: AcpProcessExit[] = [];
    const client = f.client({
      onSpawned: async (event) => {
        assert(event.args.includes("--version"));
        pid = event.pid;
        await waitUntil(
          async () => (await f.trace()).some((entry) => entry.pid === pid),
          "probe did not run",
        );
        assert(isRunning(pid), "probe was not live when admission was rejected");
        throw denial;
      },
      onExit: (event) => {
        exits.push(event);
      },
    });
    await assert.rejects(client.start(), (error) => error === denial);
    await waitUntil(() => !isRunning(pid), "rejected probe survived cleanup");
    await waitUntil(() => exits.length === 1, "missing rejected-probe exit");
    assert.equal(exits[0]?.pid, pid);
    assert(
      (await f.trace()).every(
        (entry) => entry.args[0] === "--version" && entry.event === "invocation",
      ),
    );
  },
);

test(
  "missing probe executable remains soft and differs from admission rejection",
  native,
  async (t) => {
    const f = await fixture(t);
    await fs.unlink(f.command);
    const before: AcpProcessLaunch[] = [];
    const failed: string[] = [];
    const client = f.client({
      onBeforeSpawn: (event) => {
        before.push(event);
      },
      onSpawnFailed: (event) => {
        failed.push(event.launchId);
        return new Promise<void>(() => {});
      },
      onSpawned: () => assert.fail("missing executable cannot spawn"),
      onExit: () => assert.fail("missing executable cannot exit"),
    });
    await assert.rejects(client.start(), { name: "AgentSpawnError" });
    assert.deepEqual(
      before.map((event) => event.args[0]),
      ["--version", "--acp"],
    );
    assert.deepEqual(
      failed,
      before.map((event) => event.launchId),
    );
    assert.equal(new Set(failed).size, 2);
    const denial = new Error("synthetic denial before missing executable");
    await assert.rejects(
      f
        .client({
          onBeforeSpawn: () => {
            throw denial;
          },
        })
        .start(),
      (error) => error === denial,
    );
  },
);

test("close retires an active probe and prevents the subsequent ACP launch", native, async (t) => {
  const f = await fixture(t, { ...modern, probeBehavior: "hold" });
  const entered = deferred<number>();
  const client = f.client({
    onSpawned: (event) => {
      if (event.args.includes("--version")) {
        entered.resolve(event.pid);
      }
    },
  });
  const starting = client.start();
  void starting.catch(() => {});
  await expectEntered(starting, entered.promise);
  await client.close();
  await assert.rejects(starting, /closed while the agent was starting/);
  assert.equal(isRunning(await entered.promise), false);
  assert((await f.trace()).every((entry) => entry.args[0] === "--version"));
});

test(
  "close during successful probe retirement cannot start the main process",
  native,
  async (t) => {
    const f = await fixture(t);
    const retiring = deferred<void>();
    const release = deferred<void>();
    let probePid = 0;
    let hold = true;
    const before: AcpProcessLaunch[] = [];
    const client = f.client({
      onBeforeSpawn: (event) => {
        before.push(event);
      },
      onSpawned: (event) => {
        if (event.args.includes("--version")) {
          probePid = event.pid;
        }
      },
    });
    // Deterministic source-unit fence test. Native public proof remains separate.
    const internal = client as unknown as {
      terminateAgentProcess(child: ChildProcess): Promise<void>;
    };
    const terminate = internal.terminateAgentProcess.bind(client);
    internal.terminateAgentProcess = async (child) => {
      await terminate(child);
      if (child.pid === probePid && hold) {
        retiring.resolve(undefined);
        await release.promise;
      }
    };
    const starting = client.start();
    void starting.catch(() => {});
    try {
      await expectEntered(starting, retiring.promise);
      const closing = client.close();
      hold = false;
      release.resolve(undefined);
      await closing;
      await assert.rejects(starting, /closed while the agent was starting/);
      assert.deepEqual(
        before.map((event) => event.args[0]),
        ["--version"],
      );
    } finally {
      hold = false;
      release.resolve(undefined);
      await starting.catch(() => {});
    }
  },
);

test(
  "outer runtime deadline cannot admit a held probe after client retirement",
  native,
  async (t) => {
    const f = await fixture(t);
    const entered = deferred<void>();
    const release = deferred<void>();
    const runtime = createAcpRuntime({
      cwd: f.root,
      sessionStore: createFileSessionStore({ stateDir: path.join(f.root, "state") }),
      agentRegistry: createAgentRegistry({ overrides: { fixture: f.options.agentArgv! } }),
      permissionMode: "deny-all",
      timeoutMs: 500,
      processLifecycle: {
        onBeforeSpawn: async () => {
          entered.resolve(undefined);
          await release.promise;
        },
      },
    });
    const ensuring = runtime.ensureSession({
      sessionKey: "deadline",
      agent: "fixture",
      mode: "persistent",
    });
    void ensuring.catch(() => {});
    try {
      await expectEntered(ensuring, entered.promise);
      await assert.rejects(ensuring, { code: "ACP_SESSION_INIT_FAILED" });
      release.resolve(undefined);
      await runtime.shutdown();
      assert.deepEqual(await f.trace(), []);
    } finally {
      release.resolve(undefined);
      await runtime.shutdown();
    }
  },
);

test(
  "denied later Gemini diagnostic preserves the original timeout without a second probe",
  native,
  async (t) => {
    const f = await fixture(t, { version: "0.41.1", flag: "--acp", silentInitialize: true });
    await fs.mkdir(path.join(f.root, "workspace"));
    const config = {
      ...f.config,
      denyDiagnostic: true,
      sessionEnv: { PATH: `${path.dirname(f.command)}:/usr/bin:/bin` },
      runtimeEnv: { GEMINI_API_KEY: "synthetic-not-a-provider-key" },
    };
    await fs.writeFile(f.configPath, JSON.stringify(config));
    const { stdout, stderr } = await runFile(process.execPath, [peerPath, "driver", f.configPath], {
      cwd: f.root,
      env: {
        HOME: f.root,
        PATH: `${path.dirname(f.command)}:/usr/bin:/bin`,
        ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS: "1000",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout) as DriverResult;
    assert.equal(result.errorName, "GeminiAcpStartupTimeoutError");
    assert.equal(result.versionAdmissions, 2);
    assert.match(result.message ?? "", /Gemini CLI ACP startup timed out/);
    assert.doesNotMatch(
      result.message ?? "",
      /Detected Gemini CLI version|synthetic diagnostic admission denied|synthetic-not-a-provider-key|No GEMINI_API_KEY/,
    );
    assert.deepEqual(
      (await f.trace()).map((entry) => entry.args[0]),
      ["--version", "--acp"],
    );
  },
);

test(
  "timed-out probe retires its inherited-pipe descendant before main admission",
  native,
  async (t) => {
    const f = await fixture(t, { ...modern, probeBehavior: "inherited-pipes" });
    const stopMain = new Error("synthetic main admission denied after timed-out probe");
    const client = f.client({
      onBeforeSpawn: (event) => {
        if (!event.args.includes("--version")) {
          throw stopMain;
        }
      },
    });
    await assert.rejects(client.start(), (error) => error === stopMain);
    const trace = await f.trace();
    assert.equal(trace.filter((entry) => entry.event === "invocation").length, 1);
    assert.equal(trace.filter((entry) => entry.event === "descendant").length, 1);
    assert.equal(
      trace.some((entry) => entry.event === "safety-deadline"),
      false,
    );
    for (const entry of trace) {
      await waitUntil(
        () => !isRunning(entry.pid),
        "owned probe or inherited-pipe descendant survived",
      );
    }
  },
);
