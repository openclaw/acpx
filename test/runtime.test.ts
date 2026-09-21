import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AcpRuntimeError,
  AcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  createRuntimeStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  type AcpRuntimeEvent,
  type AcpSessionRecord,
} from "../src/runtime.js";
import { withTempHome } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function createSessionRecord(overrides: Partial<AcpSessionRecord> = {}): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "agent:codex:acp:test",
    acpSessionId: "sid-1",
    agentSessionId: "inner-1",
    agentCommand: "codex --acp",
    cwd: "/tmp/acpx",
    name: "agent:codex:acp:test",
    createdAt: "2026-04-05T00:00:00.000Z",
    lastUsedAt: "2026-04-05T00:00:00.000Z",
    lastSeq: 0,
    eventLog: {
      active_path: "",
      segment_count: 0,
      max_segment_bytes: 0,
      max_segments: 0,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    messages: [],
    updated_at: "2026-04-05T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
    ...overrides,
  };
}

function emptyRuntimeEvents(): AsyncIterable<AcpRuntimeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
      return {
        async next() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

test("AcpxRuntime delegates session lifecycle to the runtime manager", async () => {
  const encoded = encodeAcpxRuntimeHandleState({
    name: "agent:codex:acp:test",
    agent: "codex",
    cwd: "/tmp/acpx",
    mode: "persistent",
    acpxRecordId: "agent:codex:acp:test",
    backendSessionId: "sid-1",
    agentSessionId: "inner-1",
  });

  assert.deepEqual(decodeAcpxRuntimeHandleState(encoded), {
    name: "agent:codex:acp:test",
    agent: "codex",
    cwd: "/tmp/acpx",
    mode: "persistent",
    acpxRecordId: "agent:codex:acp:test",
    backendSessionId: "sid-1",
    agentSessionId: "inner-1",
  });

  const record = createSessionRecord();
  let ensuredMode: string | undefined;
  let turnMode: string | undefined;
  let turnSessionMode: string | undefined;
  let turnTimeoutMs: number | undefined;
  let closedStreamRequestId: string | undefined;
  let cancelCalls = 0;
  let managerCancelCalls = 0;
  let closeDiscardPersistentState: boolean | undefined;
  let promptStarted = Promise.resolve();
  const manager = {
    ensureSession: async (input: { mode: string }) => {
      ensuredMode = input.mode;
      return record;
    },
    startTurn(input: { mode: string; sessionMode: string; timeoutMs?: number; requestId: string }) {
      turnMode = input.mode;
      turnSessionMode = input.sessionMode;
      turnTimeoutMs = input.timeoutMs;
      return {
        requestId: input.requestId,
        promptStarted,
        events: (async function* () {
          yield { type: "text_delta" as const, text: "hello", stream: "output" as const };
        })(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: async () => {
          cancelCalls += 1;
        },
        closeStream: async (_input?: { reason?: string }) => {
          closedStreamRequestId = input.requestId;
        },
      };
    },
    async *runTurn(input: {
      mode: string;
      sessionMode: string;
      timeoutMs?: number;
      requestId: string;
    }) {
      turnMode = input.mode;
      turnSessionMode = input.sessionMode;
      turnTimeoutMs = input.timeoutMs;
      yield { type: "text_delta" as const, text: "hello", stream: "output" as const };
      yield { type: "done" as const, stopReason: "end_turn" };
    },
    getStatus: async () => ({
      summary: "status=ok",
      acpxRecordId: record.acpxRecordId,
    }),
    setMode: async () => {},
    setConfigOption: async () => ({ configOptions: [] }),
    cancel: async () => {
      managerCancelCalls += 1;
    },
    close: async (_handle: unknown, options?: { discardPersistentState?: boolean }) => {
      closeDiscardPersistentState = options?.discardPersistentState;
    },
  };

  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp/acpx",
      sessionStore: createFileSessionStore({ stateDir: "/tmp/acpx-state" }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "approve-reads",
    },
    {
      managerFactory: () => manager as never,
    },
  );

  const handle = await runtime.ensureSession({
    sessionKey: "agent:codex:acp:test",
    agent: "codex",
    mode: "oneshot",
  });

  assert.equal(ensuredMode, "oneshot");
  assert.equal(handle.acpxRecordId, "agent:codex:acp:test");
  assert.equal(handle.backendSessionId, "sid-1");
  assert.equal(handle.agentSessionId, "inner-1");

  const turn = runtime.startTurn({
    handle,
    text: "hello",
    mode: "steer",
    requestId: "req-1",
    timeoutMs: 42,
  });
  await turn.promptStarted;
  const events = [];
  for await (const event of turn.events) {
    events.push(event);
  }
  const result = await turn.result;

  assert.equal(turnMode, "steer");
  assert.equal(turnSessionMode, "oneshot");
  assert.equal(turnTimeoutMs, 42);
  assert.deepEqual(events, [{ type: "text_delta", text: "hello", stream: "output" }]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });

  promptStarted = Promise.reject(new Error("prompt failed before request creation"));
  void promptStarted.catch(() => {});
  const failedReadinessTurn = runtime.startTurn({
    handle,
    text: "fail before request",
    mode: "prompt",
    requestId: "req-readiness-failure",
  });
  await assert.rejects(failedReadinessTurn.promptStarted, /failed before request creation/);

  const legacyEvents: AcpRuntimeEvent[] = [];
  for await (const event of runtime.runTurn({
    handle,
    text: "legacy",
    mode: "prompt",
    requestId: "req-legacy",
  })) {
    legacyEvents.push(event);
  }
  assert.deepEqual(legacyEvents, [
    { type: "text_delta", text: "hello", stream: "output" },
    { type: "done", stopReason: "end_turn" },
  ]);

  await runtime.getStatus({ handle });
  await runtime.setMode({ handle, mode: "architect" });
  assert.deepEqual(await runtime.setConfigOption({ handle, key: "approval", value: "manual" }), {
    configOptions: [],
  });
  await runtime.cancel({ handle, reason: "legacy cancel" });
  await turn.closeStream({ reason: "observer closed stream" });
  await turn.cancel();
  await runtime.close({ handle, reason: "test", discardPersistentState: true });
  assert.equal(closedStreamRequestId, "req-1");
  assert.equal(cancelCalls, 1);
  assert.equal(managerCancelCalls, 1);
  assert.equal(closeDiscardPersistentState, true);
});

test("AcpxRuntime keeps session ownership from initialization through idle updates and oneshot cleanup", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-owner-"));
  const stateDir = path.join(rootDir, "state");
  const persistentPidFile = path.join(rootDir, "persistent.pid");
  const oneshotPidFile = path.join(rootDir, "oneshot.pid");
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const runtime = createAcpRuntime({
    cwd: rootDir,
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [
          process.execPath,
          MOCK_AGENT_PATH,
          "--advertise-commands-after-new",
          "--pid-file",
          persistentPidFile,
        ],
        "fixture-oneshot": [process.execPath, MOCK_AGENT_PATH, "--pid-file", oneshotPidFile],
      },
    }),
    permissionMode: "approve-reads",
  });

  const persistentHandle = await runtime.ensureSession({
    sessionKey: "owned-persistent",
    agent: "fixture",
    mode: "persistent",
  });
  const status = await waitForRuntimeStatus(
    async () => await runtime.getStatus({ handle: persistentHandle }),
    (value) => value.availableCommands?.[0]?.name === "fixture-command",
  );
  assert.deepEqual(status.availableCommands, [
    {
      name: "fixture-command",
      description: "Advertised after session creation",
      hasInput: false,
    },
  ]);
  await runtime.close({ handle: persistentHandle, reason: "test complete" });

  const firstHandle = await runtime.ensureSession({
    sessionKey: "owned-oneshot",
    agent: "fixture-oneshot",
    mode: "oneshot",
  });
  const secondHandle = await runtime.ensureSession({
    sessionKey: "owned-oneshot",
    agent: "fixture-oneshot",
    mode: "oneshot",
  });
  assert.equal(firstHandle.acpxRecordId, secondHandle.acpxRecordId);
  assert.equal(firstHandle.backendSessionId, secondHandle.backendSessionId);

  const turn = runtime.startTurn({
    handle: secondHandle,
    text: "echo owner cleanup",
    mode: "prompt",
    requestId: "req-owner-cleanup",
  });
  for await (const event of turn.events) {
    // Drain the public event stream before observing terminal cleanup.
    void event;
  }
  assert.deepEqual(await turn.result, { status: "completed", stopReason: "end_turn" });

  const oneshotPid = Number((await fs.readFile(oneshotPidFile, "utf8")).trim());
  await waitForRuntimeStatus(
    () => isProcessRunning(oneshotPid),
    (running) => !running,
  );
});

async function waitForRuntimeStatus<T>(
  read: () => Promise<T> | T,
  matches: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  assert.equal(matches(value), true);
  return value;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("createFileSessionStore persists records inside the provided state directory", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-store-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = createFileSessionStore({ stateDir });
  const record = createSessionRecord({
    acpxRecordId: "agent:codex:acp:stored",
    acpSessionId: "sid-stored",
  });

  await store.save(record);
  const loaded = await store.load("agent:codex:acp:stored");

  assert.equal(loaded?.acpxRecordId, "agent:codex:acp:stored");
  assert.equal(loaded?.acpSessionId, "sid-stored");
  assert.equal(
    await fs
      .readFile(path.join(stateDir, "sessions", "agent%3Acodex%3Aacp%3Astored.json"), "utf8")
      .then((payload) => payload.includes('"schema": "acpx.session.v1"')),
    true,
  );
});

test("createFileSessionStore preserves environment name casing across reloads", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-env-store-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const env = { INITIAL_AGENT_MODE: "read-only", CustomMixedCase: "synthetic" };
  const record = createSessionRecord({ acpx: { session_options: { env } } });

  await createFileSessionStore({ stateDir }).save(record);

  const restored = await createFileSessionStore({ stateDir }).load(record.acpxRecordId);
  assert.deepEqual(restored?.acpx?.session_options?.env, env);
});

for (const [scenario, existingFileMode, existingDirMode] of [
  ["new records", undefined, undefined],
  ["private rewrites", 0o600, 0o700],
  ["legacy shared rewrites", 0o664, 0o775],
  ["symlinked session directories", undefined, undefined],
] as const) {
  test(
    `createFileSessionStore keeps ${scenario} private under a permissive umask`,
    { skip: process.platform === "win32" },
    async (t) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-store-private-"));
      t.after(async () => {
        await fs.rm(stateDir, { recursive: true, force: true });
      });
      const previousUmask = process.umask(0o002);
      try {
        const store = createFileSessionStore({ stateDir });
        const record = createSessionRecord({ title: "before" });
        const sessionDir = path.join(stateDir, "sessions");
        const recordPath = path.join(sessionDir, `${encodeURIComponent(record.acpxRecordId)}.json`);
        const symlinkTarget = path.join(stateDir, "session-target");

        if (scenario === "symlinked session directories") {
          await fs.mkdir(symlinkTarget, { mode: 0o775 });
          await fs.symlink(symlinkTarget, sessionDir, "dir");
        }

        if (existingFileMode !== undefined && existingDirMode !== undefined) {
          await store.save(record);
          await fs.chmod(recordPath, existingFileMode);
          await fs.chmod(sessionDir, existingDirMode);
        }

        record.title = "after";
        record.messages = [{ Agent: { content: [{ Text: "saved reply" }], tool_results: {} } }];
        await store.save(record);

        assert.equal((await fs.stat(recordPath)).mode & 0o777, 0o600, "session record mode");
        assert.equal((await fs.stat(sessionDir)).mode & 0o777, 0o700, "session directory mode");
        if (scenario === "symlinked session directories") {
          assert.equal(await fs.readlink(sessionDir), symlinkTarget);
          assert.equal((await fs.stat(symlinkTarget)).mode & 0o777, 0o700, "symlink target mode");
        }
        const restored = await createFileSessionStore({ stateDir }).load(record.acpxRecordId);
        assert.equal(restored?.title, "after");
        assert.deepEqual(restored?.messages, record.messages);
      } finally {
        process.umask(previousUmask);
      }
    },
  );
}

test("createFileSessionStore supports concurrent saves with long session IDs in the same millisecond", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-store-concurrent-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const originalNow = Date.now;
  Date.now = () => 1_750_000_000_000;
  t.after(() => {
    Date.now = originalNow;
  });

  const store = createFileSessionStore({ stateDir });
  const record = createSessionRecord({
    acpxRecordId: "x".repeat(220),
    acpSessionId: "sid-concurrent",
  });

  await Promise.all(Array.from({ length: 8 }, () => store.save(record)));

  const loaded = await store.load(record.acpxRecordId);
  assert.equal(loaded?.acpSessionId, "sid-concurrent");
  assert.deepEqual(await fs.readdir(path.join(stateDir, "sessions")), [
    `${record.acpxRecordId}.json`,
  ]);
});

test("createFileSessionStore.load() returns undefined for a corrupt session file (#378)", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-store-corrupt-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = createFileSessionStore({ stateDir });
  const sessionId = "agent:codex:acp:corrupt";
  const record = createSessionRecord({ acpxRecordId: sessionId, acpSessionId: "sid-corrupt" });
  await store.save(record);

  const sessionFile = path.join(stateDir, "sessions", `${encodeURIComponent(sessionId)}.json`);

  // Truncated JSON (e.g. a SIGKILL/power-loss mid-write before the atomic rename, or
  // a half-flushed external write). Pre-fix, JSON.parse threw a SyntaxError straight
  // out of the public load(); every internal reader already recovers from this.
  await fs.writeFile(sessionFile, '{"schema":"acpx.session.v1","acpx', "utf8");
  assert.equal(await store.load(sessionId), undefined);

  // Structurally-valid JSON of the wrong shape is also "no usable record".
  await fs.writeFile(sessionFile, '{"not":"a session record"}', "utf8");
  assert.equal(await store.load(sessionId), undefined);

  // A rewritten valid record still loads — recovery does not mask good data.
  await store.save(record);
  assert.equal((await store.load(sessionId))?.acpSessionId, "sid-corrupt");
});

test("doctor reports backend unavailable probe failures and agent registry honors overrides", async () => {
  const registry = createAgentRegistry({
    overrides: {
      codex: "codex-override --acp",
    },
  });

  assert.equal(registry.resolve("codex"), "codex-override --acp");

  const runtime = new AcpxRuntime(
    {
      cwd: "/workspace",
      sessionStore: createFileSessionStore({ stateDir: "/tmp/acpx-runtime-doctor" }),
      agentRegistry: registry,
      permissionMode: "approve-reads",
    },
    {
      probeRunner: async () => ({
        ok: false,
        message: "embedded ACP runtime probe failed",
        details: ["agent=codex", "command=codex-override --acp"],
      }),
    },
  );

  const report = await runtime.doctor();
  assert.equal(report.ok, false);
  assert.equal(report.code, "ACP_BACKEND_UNAVAILABLE");
  assert.deepEqual(report.details, ["agent=codex", "command=codex-override --acp"]);
});

test("agent registry preserves structured argv overrides", () => {
  const registry = createAgentRegistry({
    overrides: {
      Custom: ["C:\\tools\\bin\\agent.sh", "--pipe", "\\\\.\\pipe\\acpx-agent"],
      droid: ["C:\\tools\\droid.exe", "--acp"],
      blank: "   ",
    },
  });

  assert.deepEqual(registry.resolve("custom"), [
    "C:\\tools\\bin\\agent.sh",
    "--pipe",
    "\\\\.\\pipe\\acpx-agent",
  ]);
  assert.equal(registry.resolve("blank"), "blank");
  assert.deepEqual(registry.resolve("factorydroid"), ["C:\\tools\\droid.exe", "--acp"]);
  assert.equal(registry.list().includes("Custom"), false);
  assert.equal(registry.list().includes("custom"), true);
});

test("doctor coerces probe detail values to strings", async () => {
  const circular: Record<string, unknown> = { code: "BROKEN" };
  circular.self = circular;
  const runtime = new AcpxRuntime(
    {
      cwd: "/workspace",
      sessionStore: createFileSessionStore({ stateDir: "/tmp/acpx-runtime-doctor-details" }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "approve-reads",
    },
    {
      probeRunner: async () => ({
        ok: false,
        message: "embedded ACP runtime probe failed",
        details: ["agent=codex", new Error("spawn failed"), circular],
      }),
    },
  );

  const report = await runtime.doctor();
  assert.equal(report.ok, false);
  assert.equal(
    report.details?.every((detail) => typeof detail === "string"),
    true,
  );
  assert.match(report.details?.[1] ?? "", /spawn failed/);
  assert.equal(report.details?.[2], '{"code":"BROKEN","self":"[Circular]"}');
});

test("AcpxRuntime validates required ensureSession inputs and runtime handles", async () => {
  const runtime = createAcpRuntime({
    cwd: "/workspace",
    sessionStore: createFileSessionStore({ stateDir: "/tmp/acpx-runtime-invalid" }),
    agentRegistry: createAgentRegistry(),
    permissionMode: "approve-reads",
  });

  await assert.rejects(
    async () =>
      await runtime.ensureSession({
        sessionKey: "   ",
        agent: "codex",
        mode: "persistent",
      }),
    (error: unknown) => {
      assert(error instanceof AcpRuntimeError);
      assert.equal(error.code, "ACP_SESSION_INIT_FAILED");
      assert.match(error.message, /session key is required/);
      return true;
    },
  );
  await assert.rejects(
    async () =>
      await runtime.ensureSession({
        sessionKey: "agent:codex:acp:test",
        agent: "   ",
        mode: "persistent",
      }),
    /ACP agent id is required/,
  );
  await assert.rejects(
    async () =>
      await runtime.getStatus({
        handle: {
          sessionKey: "agent:codex:acp:test",
          backend: "acpx",
          runtimeSessionName: "   ",
        },
      }),
    /runtimeSessionName is missing/,
  );
});

test("AcpxRuntime falls back to plain runtimeSessionName handles and reuses a single manager instance", async () => {
  const record = createSessionRecord({
    acpxRecordId: "session-from-handle",
    acpSessionId: "sid-handle",
    agentSessionId: "inner-handle",
    cwd: "/workspace",
  });
  let managerFactoryCalls = 0;
  const manager = {
    ensureSession: async () => record,
    startTurn(input: { requestId: string }) {
      return {
        requestId: input.requestId,
        events: emptyRuntimeEvents(),
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: async () => {},
        closeStream: async () => {},
      };
    },
    getStatus: async (handle: { acpxRecordId?: string; cwd?: string }) => ({
      summary: `status=${handle.acpxRecordId}`,
      acpxRecordId: handle.acpxRecordId,
      details: {
        cwd: handle.cwd,
      },
    }),
    setMode: async () => {},
    setConfigOption: async () => {},
    closeStream: async () => {},
    cancel: async () => {},
    close: async () => {},
  };
  const runtime = new AcpxRuntime(
    {
      cwd: "/workspace",
      sessionStore: createFileSessionStore({ stateDir: "/tmp/acpx-runtime-fallback" }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "approve-reads",
    },
    {
      managerFactory: () => {
        managerFactoryCalls += 1;
        return manager as never;
      },
      probeRunner: async () => ({
        ok: true,
        message: "embedded ACP runtime ready",
      }),
    },
  );

  await runtime.probeAvailability();
  assert.equal(runtime.isHealthy(), true);
  assert.deepEqual(await runtime.getCapabilities(), {
    controls: [
      "session/set_mode",
      "session/set_model",
      "session/set_config_option",
      "session/status",
    ],
  });

  const plainHandle = {
    sessionKey: "agent:claude:acp:plain",
    backend: "acpx",
    runtimeSessionName: "plain-session-name",
    cwd: "/workspace/plain",
    acpxRecordId: "session-from-handle",
  };
  const status = await runtime.getStatus({ handle: plainHandle });
  assert.equal(status.acpxRecordId, "session-from-handle");
  assert.equal(status.details?.cwd, "/workspace/plain");

  const turn = runtime.startTurn({
    handle: plainHandle,
    text: "hello",
    mode: "prompt",
    requestId: "req-plain",
  });
  const turnEvents = [];
  for await (const event of turn.events) {
    turnEvents.push(event);
  }
  const result = await turn.result;
  assert.deepEqual(turnEvents, []);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  assert.equal(managerFactoryCalls, 1);
});

for (const shape of ["unscoped", "missing", "empty", "configured"] as const) {
  test(`runtime capability results own their mutable arrays for ${shape} metadata`, async () => {
    await withTempHome("acpx-capabilities-", async (cwd) => {
      const stores = ["a", "b"].map((name) =>
        createFileSessionStore({ stateDir: path.join(cwd, name) }),
      );
      const record = createSessionRecord({
        cwd,
        acpx:
          shape === "configured"
            ? {
                config_options: ["mode", "model", "mode"].map((id) => ({
                  id,
                  name: id,
                  type: "select",
                  currentValue: "default",
                  options: [{ value: "default", name: "Default" }],
                })),
              }
            : {},
      });
      if (shape !== "missing") {
        for (const store of stores) {
          await store.save(record);
        }
      }
      const runtimes = stores.map((sessionStore) =>
        createAcpRuntime({
          cwd,
          sessionStore,
          agentRegistry: createAgentRegistry(),
          permissionMode: "deny-all",
        }),
      );
      const input =
        shape === "unscoped"
          ? undefined
          : {
              handle: {
                sessionKey: record.acpxRecordId,
                backend: "acpx",
                cwd,
                runtimeSessionName: record.name ?? record.acpxRecordId,
                acpxRecordId: record.acpxRecordId,
              },
            };
      const expected = {
        controls: [
          "session/set_mode",
          "session/set_model",
          "session/set_config_option",
          "session/status",
        ],
        ...(shape === "configured" ? { configOptionKeys: ["mode", "model"] } : {}),
      };
      const first = await runtimes[0].getCapabilities(input);
      const sibling = await runtimes[0].getCapabilities(input);
      const other = await runtimes[1].getCapabilities(input);
      // Fail before mutation on the old singleton so other tests stay independent.
      assert.notStrictEqual(first, sibling);
      assert.notStrictEqual(first.controls, sibling.controls);
      assert.notStrictEqual(first.controls, other.controls);
      if (first.configOptionKeys) {
        assert.notStrictEqual(first.configOptionKeys, sibling.configOptionKeys);
      }
      first.controls.length = 0;
      first.controls = ["session/status"];
      first.configOptionKeys?.push("changed");
      first.configOptionKeys = ["injected"];
      assert.deepEqual(sibling, expected);
      assert.deepEqual(other, expected);
      for (const runtime of runtimes) {
        assert.deepEqual(await runtime.getCapabilities(input), expected);
      }
      if (shape !== "missing") {
        const stored = await stores[0].load(record.acpxRecordId);
        assert.deepEqual(stored?.acpx?.config_options, record.acpx?.config_options);
      }
    });
  });
}

test("AcpxRuntime exposes advertised config option keys for resolved handles", async (t) => {
  const encoded = encodeAcpxRuntimeHandleState({
    name: "agent:codex:acp:test",
    agent: "codex",
    cwd: "/workspace",
    mode: "persistent",
    acpxRecordId: "agent:codex:acp:test",
    backendSessionId: "sid-1",
    agentSessionId: "inner-1",
  });
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-config-options-"));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const store = createFileSessionStore({ stateDir });
  await store.save(
    createSessionRecord({
      acpx: {
        config_options: [
          {
            id: "mode",
            name: "Mode",
            type: "select",
            currentValue: "ask",
            options: [{ value: "ask", name: "Ask" }],
          },
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "fast",
            options: [{ value: "fast", name: "Fast" }],
          },
          {
            id: "mode",
            name: "Mode",
            type: "select",
            currentValue: "ask",
            options: [{ value: "ask", name: "Ask" }],
          },
        ],
      },
    }),
  );
  const runtime = new AcpxRuntime({
    cwd: "/workspace",
    sessionStore: store,
    agentRegistry: createAgentRegistry(),
    permissionMode: "approve-reads",
  });

  assert.deepEqual(
    await runtime.getCapabilities({
      handle: {
        sessionKey: "ignored-session-key",
        backend: "acpx",
        runtimeSessionName: encoded,
      },
    }),
    {
      controls: [
        "session/set_mode",
        "session/set_model",
        "session/set_config_option",
        "session/status",
      ],
      configOptionKeys: ["mode", "model"],
    },
  );
});

test("createRuntimeStore is an alias for the file-backed session store", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-store-alias-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = createRuntimeStore({ stateDir });
  const record = createSessionRecord({
    acpxRecordId: "alias-record",
    acpSessionId: "alias-sid",
  });
  await store.save(record);
  const loaded = await store.load("alias-record");

  assert.equal(loaded?.acpSessionId, "alias-sid");
});

test("AcpxRuntime snapshots transient child environment for manager and probes", async () => {
  const agentProcessEnv = { ACPX_TEST_RUNTIME_OVERLAY: "construction-value" };
  const observed: unknown[] = [];
  const runtime = new AcpxRuntime(
    {
      cwd: process.cwd(),
      sessionStore: createFileSessionStore({
        stateDir: path.join(os.tmpdir(), "unused-env-store"),
      }),
      agentRegistry: createAgentRegistry(),
      permissionMode: "deny-all",
      agentProcessEnv,
    },
    {
      probeRunner: async (options) => {
        observed.push(options.agentProcessEnv);
        return { ok: true, message: "synthetic probe" };
      },
    },
  );
  agentProcessEnv.ACPX_TEST_RUNTIME_OVERLAY = "mutated-value";
  await runtime.doctor();
  assert.deepEqual(observed, [{ ACPX_TEST_RUNTIME_OVERLAY: "construction-value" }]);
  assert.equal(process.env.ACPX_TEST_RUNTIME_OVERLAY, undefined);
});

for (const control of [
  { name: "config option", args: ["--model-config-id", "llm"], model: "fast-model" },
  { name: "legacy models", args: ["--advertise-legacy-models"], model: "alternate-model" },
]) {
  test(`public model control persists ${control.name} through active turns and reconnect`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-model-"));
    const store = createFileSessionStore({ stateDir: path.join(cwd, "state") });
    const options = {
      cwd,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [process.execPath, MOCK_AGENT_PATH, "--supports-load-session", ...control.args],
        },
      }),
      permissionMode: "approve-reads" as const,
    };
    let runtime = createAcpRuntime(options);
    t.after(async () => {
      await runtime.shutdown();
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const handle = await runtime.ensureSession({
      sessionKey: "models",
      agent: "fixture",
      mode: "persistent",
    });
    await runtime.setModel({ handle, model: control.model });
    assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, control.model);
    const turn = runtime.startTurn({
      handle,
      text: "sleep 10000",
      mode: "prompt",
      requestId: "model-active",
    });
    const events = (async () => {
      for await (const event of turn.events) {
        void event;
      }
    })();
    await turn.promptStarted;
    await runtime.setModel({ handle, model: "default-model" });
    assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, "default-model");
    await turn.cancel();
    await events;
    assert.equal((await turn.result).status, "cancelled");
    await runtime.shutdown();
    runtime = createAcpRuntime(options);
    await runtime.setModel({ handle, model: control.model });
    assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, control.model);
    const stored = await store.load(handle.acpxRecordId ?? handle.sessionKey);
    assert.equal(stored?.acpx?.session_options?.model, control.model);
    assert.equal(stored?.acpx?.current_model_id, control.model);
    await runtime.shutdown();
    runtime = createAcpRuntime(options);
    const resumed = runtime.startTurn({
      handle,
      text: "echo resumed",
      mode: "prompt",
      requestId: "model-resumed",
    });
    for await (const event of resumed.events) {
      void event;
    }
    assert.equal((await resumed.result).status, "completed");
    assert.equal((await runtime.getStatus({ handle })).models?.currentModelId, control.model);
  });

  test(`public model control preserves saved selection after ${control.name} rejection`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-model-reject-"));
    const store = createFileSessionStore({ stateDir: path.join(cwd, "state") });
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            MOCK_AGENT_PATH,
            ...control.args,
            "--set-session-model-fails",
          ],
        },
      }),
      permissionMode: "approve-reads",
    });
    t.after(async () => {
      await runtime.shutdown();
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const handle = await runtime.ensureSession({
      sessionKey: "rejected-model",
      agent: "fixture",
      mode: "persistent",
      sessionOptions: { model: "default-model" },
    });
    const before = await store.load(handle.acpxRecordId ?? handle.sessionKey);
    await assert.rejects(
      runtime.setModel({ handle, model: control.model }),
      /setSessionModel failed/,
    );
    const turn = runtime.startTurn({
      handle,
      text: "sleep 10000",
      mode: "prompt",
      requestId: "rejected-active-model",
    });
    const events = (async () => {
      for await (const event of turn.events) {
        void event;
      }
    })();
    await turn.promptStarted;
    await assert.rejects(
      runtime.setModel({ handle, model: control.model }),
      /setSessionModel failed/,
    );
    await turn.cancel();
    await events;
    assert.equal((await turn.result).status, "cancelled");
    const after = await store.load(handle.acpxRecordId ?? handle.sessionKey);
    assert.equal(after?.acpx?.current_model_id, before?.acpx?.current_model_id);
    assert.deepEqual(after?.acpx?.session_options, before?.acpx?.session_options);
  });
}

test("public model status retains legacy labels through file-store reload", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-model-labels-"));
  const options = {
    cwd,
    sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [
          process.execPath,
          MOCK_AGENT_PATH,
          "--advertise-legacy-models",
          "--supports-load-session",
        ],
      },
    }),
    permissionMode: "approve-reads" as const,
  };
  let runtime = createAcpRuntime(options);
  t.after(async () => {
    await runtime.shutdown();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const handle = await runtime.ensureSession({
    sessionKey: "label-proof",
    agent: "fixture",
    mode: "persistent",
  });
  const expected = {
    currentModelId: "default-model",
    availableModelIds: ["default-model", "alternate-model"],
    availableModels: [
      { modelId: "default-model", name: "Default Model" },
      { modelId: "alternate-model", name: "Alternate Model" },
    ],
  };
  assert.deepEqual((await runtime.getStatus({ handle })).models, expected);
  await runtime.shutdown();
  runtime = createAcpRuntime(options);
  assert.deepEqual((await runtime.getStatus({ handle })).models, expected);
});

test("public model status exposes modern labels from existing configuration snapshots", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-modern-labels-"));
  const store = createFileSessionStore({ stateDir: cwd });
  const modelId = "provider/nested/model|variant";
  const record = createSessionRecord({
    acpxRecordId: "modern-labels",
    cwd,
    acpx: {
      current_model_id: modelId,
      available_models: [modelId, "bare-model"],
      model_control: "config_option",
      config_options: [
        {
          id: "llm",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: modelId,
          options: [
            { value: modelId, name: "Native Display Name" },
            { value: "bare-model", name: "Bare Model Name" },
          ],
        },
      ],
    },
  });
  await store.save(record);
  const runtime = createAcpRuntime({
    cwd,
    sessionStore: store,
    agentRegistry: createAgentRegistry(),
    permissionMode: "deny-all",
  });
  t.after(async () => {
    await runtime.shutdown();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const handle = await runtime.findSession({ sessionKey: "modern-labels", agent: "codex" });
  assert.ok(handle);
  assert.deepEqual((await runtime.getStatus({ handle })).models, {
    currentModelId: modelId,
    availableModelIds: [modelId, "bare-model"],
    availableModels: [
      { modelId, name: "Native Display Name" },
      { modelId: "bare-model", name: "Bare Model Name" },
    ],
  });
});

for (const turnCount of [0, 1, 2]) {
  test(`public fresh-session preparation survives restart after ${turnCount} submitted turns without remote close support`, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fresh-session-"));
    const options = {
      cwd,
      sessionStore: createFileSessionStore({ stateDir: path.join(cwd, "state") }),
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            MOCK_AGENT_PATH,
            "--supports-load-session",
            "--cancel-delay-ms",
            "200",
          ],
        },
      }),
      permissionMode: "approve-reads" as const,
    };
    let runtime = createAcpRuntime(options);
    t.after(async () => {
      await runtime.shutdown();
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const input = { sessionKey: "fresh-proof", agent: "fixture", mode: "persistent" as const };
    const original = await runtime.ensureSession(input);
    await runtime.close({ handle: original, reason: "release resources" });
    await runtime.shutdown();
    runtime = createAcpRuntime(options);
    const resumed = await runtime.ensureSession(input);
    assert.equal(resumed.backendSessionId, original.backendSessionId);
    await assert.rejects(
      runtime.close({ handle: resumed, reason: "discard", discardPersistentState: true }),
      /does not support session\/close/,
    );
    assert.equal(
      (await options.sessionStore.load(input.sessionKey))?.acpx?.reset_on_next_ensure,
      undefined,
    );
    let turnsSettled = 0;
    for (let index = 0; index < turnCount; index += 1) {
      const retiring = runtime.startTurn({
        handle: resumed,
        text: "stream-sleep 30000 retiring",
        mode: "prompt",
        requestId: `retiring-turn-${index}`,
      });
      void retiring.result.then(() => {
        turnsSettled += 1;
      });
      if (index === 0) {
        for await (const event of retiring.events) {
          if (event.type === "text_delta" && event.text.includes("retiring")) {
            break;
          }
        }
      }
    }
    await runtime.prepareFreshSession({ handle: resumed });
    assert.equal(
      turnsSettled,
      turnCount,
      "preparation acknowledged before all submitted turns finalized",
    );
    assert.equal(
      (await options.sessionStore.load(input.sessionKey))?.acpx?.reset_on_next_ensure,
      true,
    );
    await runtime.shutdown();
    runtime = createAcpRuntime(options);
    const fresh = await runtime.ensureSession(input);
    assert.notEqual(fresh.backendSessionId, original.backendSessionId);
    assert.equal(
      (await options.sessionStore.load(input.sessionKey))?.acpx?.reset_on_next_ensure,
      undefined,
    );
    const turn = runtime.startTurn({
      handle: fresh,
      text: "fresh prompt",
      mode: "prompt",
      requestId: "fresh-turn",
    });
    for await (const event of turn.events) {
      assert.notEqual(event.type, "error");
    }
    assert.equal((await turn.result).status, "completed");
  });
}
