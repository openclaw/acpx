import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as currentRuntime from "../src/runtime.js";

type RuntimeModule = Pick<
  typeof currentRuntime,
  "createAcpRuntime" | "createAgentRegistry" | "createFileSessionStore" | "AcpRuntimeError"
>;
type Pids = { bridge: number; descendant: number };
type Request = { method?: string; params?: { sessionId?: string } };
const fixture = path.resolve("dist-test/test/fixtures/process-cleanup-agent.js");
// Allow process/IPC startup under the full suite before testing the stalled setup phase.
const timeoutMs = 5_000;
// Optional published-runtime comparison; the ordinary suite always runs the real-client cases.
const candidatePath = process.env.ACPX_SETUP_CANDIDATE_RUNTIME;
const candidate = candidatePath
  ? ((await import(pathToFileURL(path.resolve(candidatePath)).href)) as RuntimeModule)
  : currentRuntime;
const baselinePath = process.env.ACPX_SETUP_BASELINE_RUNTIME;
const baseline = baselinePath
  ? ((await import(pathToFileURL(path.resolve(baselinePath)).href)) as RuntimeModule)
  : undefined;

function isRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  assert.ifError(result.error);
  if (result.status === 1) {
    return false;
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() !== "" && !result.stdout.trim().startsWith("Z");
}

async function assertStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isRunning(pid) && Date.now() < deadline) {
    await delay(20);
  }
  assert.equal(isRunning(pid), false, "owned fixture process survived cleanup");
}

async function requests(pidFile: string): Promise<Request[]> {
  return (await fs.readFile(`${pidFile}.messages`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Request);
}

function options(api: RuntimeModule, cwd: string, mode: string, pidFile: string) {
  return {
    cwd,
    sessionStore: api.createFileSessionStore({ stateDir: path.join(cwd, "state") }),
    agentRegistry: api.createAgentRegistry({
      overrides: { fixture: [process.execPath, fixture, mode, pidFile] },
    }),
    permissionMode: "deny-all" as const,
    fs: false,
    terminal: false,
    timeoutMs,
  };
}

async function exerciseStall(
  api: RuntimeModule,
  phase: "new" | "load" | "resume",
  label: string,
  expectPending: boolean,
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-session-setup-process-"));
  const pidFile = path.join(cwd, "pids.json");
  const mode = phase === "new" ? "session-hang" : `session-${phase}-hang`;
  const config = options(api, cwd, mode, pidFile);
  const runtime = api.createAcpRuntime(config);
  const sibling = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const startedAt = Date.now();
    const outcome = runtime
      .ensureSession({
        sessionKey: "setup",
        agent: "fixture",
        mode: "persistent",
        ...(phase === "new" ? {} : { resumeSessionId: "existing-native-session" }),
      })
      .then(
        (handle) => ({ kind: "success" as const, handle }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      outcome,
      new Promise<{ kind: "pending" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "pending" }),
          expectPending ? timeoutMs * 2.5 : timeoutMs * 2 + 15_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const elapsedMs = Date.now() - startedAt;
    if (expectPending) {
      assert.equal(
        observed.kind,
        "pending",
        "published runtime unexpectedly bounded session setup",
      );
    } else {
      assert.equal(observed.kind, "error");
      if (observed.kind !== "error") {
        throw new Error("Expected session setup rejection");
      }
      assert(observed.error instanceof candidate.AcpRuntimeError);
      assert.equal(observed.error.code, "ACP_SESSION_INIT_FAILED");
      assert.match(observed.error.message, new RegExp(`session/${phase}.*${timeoutMs}ms`));
      assert.match(observed.error.message, /Retry session setup/);
    }
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as Pids;
    if (expectPending) {
      assert(isRunning(pids.bridge));
      assert(isRunning(pids.descendant));
    } else {
      await assertStopped(pids.bridge);
      await assertStopped(pids.descendant);
    }
    await runtime.shutdown();
    await outcome;
    await assertStopped(pids.bridge);
    await assertStopped(pids.descendant);
    assert(sibling.pid && isRunning(sibling.pid), "unrelated sibling was stopped");
    assert.equal(await config.sessionStore.load("setup"), undefined);
    const trace = await requests(pidFile);
    assert.deepEqual(
      trace.map((request) => request.method),
      ["initialize", `session/${phase}`],
    );
    if (phase !== "new") {
      assert.equal(trace[1].params?.sessionId, "existing-native-session");
    }
    console.log(
      JSON.stringify({
        runtime: label,
        cleanupTrigger: expectPending ? "manual shutdown after observation" : "setup deadline",
        phase,
        timeoutMs,
        elapsedMs,
        outcome: observed.kind,
        methods: trace.map((request) => request.method),
        bridgeStopped: true,
        descendantStopped: true,
        siblingAlive: true,
        recordPublished: false,
        replacementCreated: false,
        ...(phase === "new" ? {} : { requestedSessionId: trace[1].params?.sessionId }),
      }),
    );
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      sibling.kill("SIGKILL");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}

for (const phase of ["new", "load", "resume"] as const) {
  test(
    `real client session/${phase} stall owns cleanup and preserves explicit identity`,
    { skip: process.platform === "win32", timeout: 60_000 },
    async () => {
      if (baseline) {
        await exerciseStall(baseline, phase, "published baseline", true);
      }
      await exerciseStall(candidate, phase, "candidate", false);
    },
  );
}

test(
  "published runtime state reconnects through the candidate without a replacement session",
  { skip: process.platform === "win32" || !baseline, timeout: 60_000 },
  async () => {
    assert(baseline);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-session-setup-upgrade-"));
    const pidFile = path.join(cwd, "pids.json");
    const before = baseline.createAcpRuntime(options(baseline, cwd, "session-healthy", pidFile));
    const afterConfig = options(candidate, cwd, "session-healthy", pidFile);
    const after = candidate.createAcpRuntime(afterConfig);
    try {
      const original = await before.ensureSession({
        sessionKey: "upgrade",
        agent: "fixture",
        mode: "persistent",
      });
      await before.shutdown();
      const beforePids = JSON.parse(await fs.readFile(pidFile, "utf8")) as Pids;
      await assertStopped(beforePids.bridge);
      await assertStopped(beforePids.descendant);
      const reused = await after.ensureSession({
        sessionKey: "upgrade",
        agent: "fixture",
        mode: "persistent",
      });
      assert.equal(reused.backendSessionId, original.backendSessionId);
      assert.equal(reused.acpxRecordId, original.acpxRecordId);
      const turn = after.startTurn({
        handle: reused,
        mode: "prompt",
        requestId: "upgrade-proof",
        text: "synthetic continuity check",
      });
      for await (const event of turn.events) {
        assert(event.type);
      }
      assert.equal((await turn.result).status, "completed");
      const record = await afterConfig.sessionStore.load("upgrade");
      assert.equal(record?.acpSessionId, original.backendSessionId);
      await after.shutdown();
      const afterPids = JSON.parse(await fs.readFile(pidFile, "utf8")) as Pids;
      await assertStopped(afterPids.bridge);
      await assertStopped(afterPids.descendant);
      const trace = await requests(pidFile);
      assert.deepEqual(
        trace.map((request) => request.method),
        ["initialize", "session/new", "initialize", "session/load", "session/prompt"],
      );
      console.log(
        JSON.stringify({
          upgrade: "published baseline -> candidate",
          sessionId: reused.backendSessionId,
          recordIdPreserved: true,
          methods: trace.map((request) => request.method),
          result: "completed",
          replacementCreated: false,
          bridgeStopped: true,
          descendantStopped: true,
        }),
      );
    } finally {
      await before.shutdown();
      await after.shutdown();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
