import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AcpRuntimeError,
  AcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  createRuntimeStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  type AcpSessionRecord,
} from "../src/runtime.js";

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
  let closeDiscardPersistentState: boolean | undefined;
  const manager = {
    ensureSession: async (input: { mode: string }) => {
      ensuredMode = input.mode;
      return record;
    },
    async *runTurn(input: { mode: string; sessionMode: string; timeoutMs?: number }) {
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
    setConfigOption: async () => {},
    cancel: async () => {},
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

  const events = [];
  for await (const event of runtime.runTurn({
    handle,
    text: "hello",
    mode: "steer",
    requestId: "req-1",
    timeoutMs: 42,
  })) {
    events.push(event);
  }

  assert.equal(turnMode, "steer");
  assert.equal(turnSessionMode, "oneshot");
  assert.equal(turnTimeoutMs, 42);
  assert.deepEqual(events, [
    { type: "text_delta", text: "hello", stream: "output" },
    { type: "done", stopReason: "end_turn" },
  ]);

  await runtime.getStatus({ handle });
  await runtime.setMode({ handle, mode: "architect" });
  await runtime.setConfigOption({ handle, key: "approval", value: "manual" });
  await runtime.cancel({ handle });
  await runtime.close({ handle, reason: "test", discardPersistentState: true });
  assert.equal(closeDiscardPersistentState, true);
});

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
    async *runTurn() {
      yield { type: "done" as const, stopReason: "end_turn" };
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
  assert.deepEqual(runtime.getCapabilities(), {
    controls: ["session/set_mode", "session/set_config_option", "session/status"],
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

  const turnEvents = [];
  for await (const event of runtime.runTurn({
    handle: plainHandle,
    text: "hello",
    mode: "prompt",
    requestId: "req-plain",
  })) {
    turnEvents.push(event);
  }
  assert.deepEqual(turnEvents, [{ type: "done", stopReason: "end_turn" }]);
  assert.equal(managerFactoryCalls, 1);
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
