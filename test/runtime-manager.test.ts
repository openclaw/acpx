import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import type { AcpRuntimeEvent, AcpRuntimeHandle } from "../src/runtime/public/contract.js";
import {
  createRuntimeOptions,
  InMemorySessionStore,
  makeSessionRecord,
} from "./runtime-test-helpers.js";

type FakeClientHandlers = {
  onSessionUpdate?: (notification: Record<string, unknown>) => void;
  onClientOperation?: (operation: Record<string, unknown>) => void;
};

type FakeClient = {
  initializeResult?: {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
  };
  start: () => Promise<void>;
  close: () => Promise<void>;
  createSession: (cwd: string) => Promise<{ sessionId: string; agentSessionId?: string }>;
  loadSession: (sessionId: string, cwd: string) => Promise<{ agentSessionId?: string }>;
  hasReusableSession: (sessionId: string) => boolean;
  supportsLoadSession: () => boolean;
  loadSessionWithOptions: (
    sessionId: string,
    cwd: string,
    options: { suppressReplayUpdates: boolean },
  ) => Promise<{ agentSessionId?: string }>;
  getAgentLifecycleSnapshot: () => {
    pid?: number;
    startedAt?: string;
    running: boolean;
    lastExit?: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      exitedAt: string;
      reason: string;
    };
  };
  prompt: (
    sessionId: string,
    input: unknown,
  ) => Promise<{
    stopReason: string;
  }>;
  requestCancelActivePrompt: () => Promise<boolean>;
  hasActivePrompt: () => boolean;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionConfigOption: (sessionId: string, configId: string, value: string) => Promise<void>;
  clearEventHandlers: () => void;
  setEventHandlers: (handlers: FakeClientHandlers) => void;
};

function createHandle(sessionKey: string, acpxRecordId = sessionKey): AcpRuntimeHandle {
  return {
    sessionKey,
    backend: "acpx",
    runtimeSessionName: sessionKey,
    acpxRecordId,
  };
}

async function collectEvents(iterable: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const events: AcpRuntimeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test("AcpRuntimeManager reuses compatible records without spawning a new client", async () => {
  const existing = makeSessionRecord({
    acpxRecordId: "session-key",
    acpSessionId: "sid-1",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    closed: true,
    closedAt: "2026-01-01T00:05:00.000Z",
  });
  const store = new InMemorySessionStore([existing]);
  let constructed = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        constructed += 1;
        throw new Error("clientFactory should not be called");
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "session-key",
    agent: "codex",
    mode: "persistent",
    cwd: "/workspace",
  });

  assert.equal(constructed, 0);
  assert.equal(record.acpSessionId, "sid-1");
  assert.equal(record.closed, false);
  assert.equal(store.savedRecordIds.length, 1);
});

test("AcpRuntimeManager creates and resumes sessions through the client", async () => {
  const store = new InMemorySessionStore();
  const lifecycle = {
    pid: 456,
    startedAt: "2026-01-01T00:00:00.000Z",
    running: true,
  };
  const createClient = (): FakeClient =>
    ({
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
      start: async () => {},
      close: async () => {},
      createSession: async (cwd) => {
        assert.equal(cwd, "/workspace");
        return { sessionId: "new-session", agentSessionId: "agent-session" };
      },
      loadSession: async (sessionId, cwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(cwd, "/workspace");
        return { agentSessionId: "resumed-agent" };
      },
      hasReusableSession: () => false,
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => ({ agentSessionId: "runtime-session" }),
      getAgentLifecycleSnapshot: () => lifecycle,
      prompt: async () => ({ stopReason: "end_turn" }),
      requestCancelActivePrompt: async () => false,
      hasActivePrompt: () => false,
      setSessionMode: async () => {},
      setSessionConfigOption: async () => {},
      clearEventHandlers: () => {},
      setEventHandlers: () => {},
    }) as FakeClient;
  let constructed = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        constructed += 1;
        return createClient() as never;
      },
    },
  );

  const created = await manager.ensureSession({
    sessionKey: "created-session",
    agent: "codex",
    mode: "persistent",
  });
  assert.equal(created.acpSessionId, "new-session");
  assert.equal(created.agentSessionId, "agent-session");
  assert.equal(created.protocolVersion, 1);
  assert.equal(created.eventLog.segment_count > 0, true);
  assert.match(created.eventLog.active_path, /created-session/);

  const resumed = await manager.ensureSession({
    sessionKey: "resumed-session",
    agent: "codex",
    mode: "persistent",
    resumeSessionId: "resume-session",
  });
  assert.equal(resumed.acpSessionId, "resume-session");
  assert.equal(resumed.agentSessionId, "resumed-agent");
  assert.equal(constructed, 2);
});

test("AcpRuntimeManager creates a fresh record for each oneshot session", async () => {
  const store = new InMemorySessionStore();
  let createdSessions = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          initializeResult: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
          start: async () => {},
          close: async () => {},
          createSession: async () => ({
            sessionId: `new-session-${++createdSessions}`,
            agentSessionId: `agent-session-${createdSessions}`,
          }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          loadSessionWithOptions: async () => ({ agentSessionId: "runtime-session" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const first = await manager.ensureSession({
    sessionKey: "oneshot-session",
    agent: "codex",
    mode: "oneshot",
  });
  const second = await manager.ensureSession({
    sessionKey: "oneshot-session",
    agent: "codex",
    mode: "oneshot",
  });

  assert.notEqual(first.acpxRecordId, second.acpxRecordId);
  assert.equal(first.name, "oneshot-session");
  assert.equal(second.name, "oneshot-session");
  assert.equal(store.records.size, 2);
});

test("AcpRuntimeManager streams runtime events and saves updated status", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "turn-session",
    acpSessionId: "turn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  const client: FakeClient = {
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { prompt: true },
    },
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: (sessionId) => sessionId === "turn-sid",
    supportsLoadSession: () => true,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({
      pid: 999,
      startedAt: "2026-01-01T00:00:00.000Z",
      running: true,
    }),
    prompt: async (sessionId, input) => {
      assert.equal(sessionId, "turn-sid");
      assert.equal(input, "hello");
      handlers.onSessionUpdate?.({
        sessionId: "turn-sid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      });
      handlers.onClientOperation?.({
        method: "write_file",
        status: "ok",
        summary: "saved notes.md",
      });
      return { stopReason: "end_turn" };
    },
    requestCancelActivePrompt: async () => false,
    hasActivePrompt: () => false,
    setSessionMode: async () => {},
    setSessionConfigOption: async () => {},
    clearEventHandlers: () => {
      handlers = {};
    },
    setEventHandlers: (nextHandlers) => {
      handlers = nextHandlers;
    },
  };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => client as never,
    },
  );

  const events = await collectEvents(
    manager.runTurn({
      handle: createHandle("turn-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-1",
    }),
  );

  assert.deepEqual(events, [
    { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" },
    { type: "status", text: "write_file ok saved notes.md" },
    { type: "done", stopReason: "end_turn" },
  ]);

  const saved = await store.load("turn-session");
  assert.equal(saved?.lastRequestId, "req-1");
  assert.equal(saved?.lastPromptAt != null, true);
  assert.equal(saved?.pid, 999);
  assert.equal(saved?.protocolVersion, 1);
});

test("AcpRuntimeManager routes controls through the active controller while a turn is running", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "live-session",
    acpSessionId: "live-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  let cancelRequested = 0;
  let setModeCalls = 0;
  let setConfigCalls = 0;
  let resolvePromptStart!: () => void;
  let resolvePrompt!: (value: { stopReason: string }) => void;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStart = resolve;
  });
  const promptResult = new Promise<{ stopReason: string }>((resolve) => {
    resolvePrompt = resolve;
  });
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: () => true,
    supportsLoadSession: () => true,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      resolvePromptStart();
      return await promptResult;
    },
    requestCancelActivePrompt: async () => {
      cancelRequested += 1;
      resolvePrompt({ stopReason: "cancelled" });
      return true;
    },
    hasActivePrompt: () => true,
    setSessionMode: async (_sessionId, modeId) => {
      assert.equal(modeId, "plan");
      setModeCalls += 1;
    },
    setSessionConfigOption: async (_sessionId, key, value) => {
      assert.equal(key, "approval");
      assert.equal(value, "manual");
      setConfigCalls += 1;
    },
    clearEventHandlers: () => {
      handlers = {};
    },
    setEventHandlers: (nextHandlers) => {
      handlers = nextHandlers;
    },
  };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => client as never,
    },
  );

  const eventsPromise = collectEvents(
    manager.runTurn({
      handle: createHandle("live-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-live",
    }),
  );
  await promptStarted;
  await manager.setMode(createHandle("live-session"), "plan");
  await manager.setConfigOption(createHandle("live-session"), "approval", "manual");
  await manager.cancel(createHandle("live-session"));
  const events = await eventsPromise;

  assert.equal(setModeCalls, 1);
  assert.equal(setConfigCalls, 1);
  assert.equal(cancelRequested, 1);
  assert.deepEqual(events, [{ type: "done", stopReason: "cancelled" }]);
  assert.equal(handlers.onSessionUpdate, undefined);
});

test("AcpRuntimeManager waits for oneshot load fallback to resolve before sending controls", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "fallback-session",
    acpSessionId: "stale-session",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let promptActive = false;
  let promptSessionId: string | undefined;
  let setModeSessionId: string | undefined;
  let resolveLoadFailure!: () => void;
  const loadFailure = new Promise<void>((resolve) => {
    resolveLoadFailure = resolve;
  });
  let resolvePromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStarted = resolve;
  });
  let resolvePrompt!: (value: { stopReason: string }) => void;
  const promptResult = new Promise<{ stopReason: string }>((resolve) => {
    resolvePrompt = resolve;
  });
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "fresh-session", agentSessionId: "fresh-agent" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: () => false,
    supportsLoadSession: () => true,
    loadSessionWithOptions: async () => {
      await loadFailure;
      throw { error: { code: -32002, message: "session not found" } };
    },
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async (sessionId) => {
      promptActive = true;
      promptSessionId = sessionId;
      resolvePromptStarted();
      return await promptResult;
    },
    requestCancelActivePrompt: async () => {
      promptActive = false;
      resolvePrompt({ stopReason: "cancelled" });
      return true;
    },
    hasActivePrompt: () => promptActive,
    setSessionMode: async (sessionId, modeId) => {
      assert.equal(modeId, "plan");
      setModeSessionId = sessionId;
    },
    setSessionConfigOption: async () => {},
    clearEventHandlers: () => {},
    setEventHandlers: () => {},
  };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => client as never,
    },
  );

  const eventsPromise = collectEvents(
    manager.runTurn({
      handle: createHandle("fallback-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "oneshot",
      requestId: "req-fallback",
    }),
  );
  const setModePromise = manager.setMode(createHandle("fallback-session"), "plan", "oneshot");
  resolveLoadFailure();
  await setModePromise;
  await promptStarted;
  await manager.cancel(createHandle("fallback-session"));
  const events = await eventsPromise;

  assert.equal(setModeSessionId, "fresh-session");
  assert.equal(promptSessionId, "fresh-session");
  assert.deepEqual(events, [{ type: "done", stopReason: "cancelled" }]);
});

test("AcpRuntimeManager honors aborts requested before prompt starts after oneshot load fallback", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "aborted-session",
    acpSessionId: "stale-session",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let promptCalled = false;
  let cancelCalls = 0;
  let resolveLoadFailure!: () => void;
  const loadFailure = new Promise<void>((resolve) => {
    resolveLoadFailure = resolve;
  });
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "fresh-session", agentSessionId: "fresh-agent" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: () => false,
    supportsLoadSession: () => true,
    loadSessionWithOptions: async () => {
      await loadFailure;
      throw { error: { code: -32002, message: "session not found" } };
    },
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      promptCalled = true;
      return { stopReason: "end_turn" };
    },
    requestCancelActivePrompt: async () => {
      cancelCalls += 1;
      return true;
    },
    hasActivePrompt: () => false,
    setSessionMode: async () => {},
    setSessionConfigOption: async () => {},
    clearEventHandlers: () => {},
    setEventHandlers: () => {},
  };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => client as never,
    },
  );
  const controller = new AbortController();

  const eventsPromise = collectEvents(
    manager.runTurn({
      handle: createHandle("aborted-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "oneshot",
      requestId: "req-abort",
      signal: controller.signal,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  resolveLoadFailure();
  const events = await eventsPromise;

  assert.equal(promptCalled, false);
  assert.equal(cancelCalls, 0);
  assert.deepEqual(events, [{ type: "done", stopReason: "cancelled" }]);
});

test("AcpRuntimeManager handles offline oneshot controls, status, close, and missing records", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "offline-session:oneshot:1",
    acpSessionId: "offline-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  const setModeSessions: string[] = [];
  const setConfigSessions: string[] = [];
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "fresh-offline" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async (sessionId: string) => {
            setModeSessions.push(sessionId);
          },
          setSessionConfigOption: async (sessionId: string) => {
            setConfigSessions.push(sessionId);
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const handle = createHandle("offline-session", "offline-session:oneshot:1");

  const status = await manager.getStatus(handle);
  assert.match(status.summary ?? "", /session=offline-session/);
  assert.equal(status.details?.closed, false);

  await manager.setMode(handle, "plan", "oneshot");
  await manager.setConfigOption(handle, "approval", "manual", "oneshot");
  await manager.close(handle);

  assert.deepEqual(setModeSessions, ["fresh-offline", "fresh-offline"]);
  assert.deepEqual(setConfigSessions, ["fresh-offline"]);

  const closed = await store.load("offline-session:oneshot:1");
  assert.equal(closed?.closed, true);
  assert.equal(typeof closed?.closedAt, "string");

  await assert.rejects(
    async () => await manager.getStatus(createHandle("missing-session")),
    /ACP session not found/,
  );
});

test("AcpRuntimeManager fails offline persistent controls clearly when session/load is unavailable", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "offline-persistent-session",
    acpSessionId: "offline-persistent-backend-session",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let createSessionCalls = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => {
            createSessionCalls += 1;
            return { sessionId: "fresh-offline" };
          },
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  await assert.rejects(
    async () => await manager.setMode(createHandle("offline-persistent-session"), "plan"),
    /Persistent ACP session offline-persistent-backend-session could not be resumed: agent does not support session\/load/,
  );
  await assert.rejects(
    async () =>
      await manager.setConfigOption(
        createHandle("offline-persistent-session"),
        "approval",
        "manual",
      ),
    /Persistent ACP session offline-persistent-backend-session could not be resumed: agent does not support session\/load/,
  );
  assert.equal(createSessionCalls, 0);
});

test("AcpRuntimeManager surfaces normalized prompt failures", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "error-session",
    acpSessionId: "error-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => true,
          supportsLoadSession: () => true,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => {
            throw new Error("prompt exploded");
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const events = await collectEvents(
    manager.runTurn({
      handle: createHandle("error-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-error",
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.match((events[0] as { message: string }).message, /prompt exploded/);
});

test("AcpRuntimeManager rejects unsupported runtime attachment media types", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "attachment-session",
    acpSessionId: "attachment-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => true,
          supportsLoadSession: () => true,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  await assert.rejects(
    async () =>
      await collectEvents(
        manager.runTurn({
          handle: createHandle("attachment-session"),
          text: "",
          attachments: [{ mediaType: "application/pdf", data: "Zm9v" }],
          mode: "prompt",
          sessionMode: "persistent",
          requestId: "req-attachment",
        }),
      ),
    /Unsupported ACP runtime attachment media type: application\/pdf/,
  );
});

test("AcpRuntimeManager fails persistent turns clearly when session/load is unavailable", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "persistent-session",
    acpSessionId: "persistent-backend-session",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let createSessionCalls = 0;
  let promptCalls = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => {
            createSessionCalls += 1;
            return { sessionId: "fresh-session" };
          },
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => {
            promptCalls += 1;
            return { stopReason: "end_turn" };
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const events = await collectEvents(
    manager.runTurn({
      handle: createHandle("persistent-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-persistent",
    }),
  );

  assert.deepEqual(events, [
    {
      type: "error",
      code: "RUNTIME",
      message:
        "Persistent ACP session persistent-backend-session could not be resumed: agent does not support session/load",
      retryable: true,
    },
  ]);
  assert.equal(createSessionCalls, 0);
  assert.equal(promptCalls, 0);
});

test("AcpRuntimeManager still falls back to a fresh session for oneshot turns", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "oneshot-session:oneshot:1",
    acpSessionId: "stale-backend-session",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let promptSessionId: string | undefined;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({
            sessionId: "fresh-session",
            agentSessionId: "fresh-agent",
          }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async (sessionId: string) => {
            promptSessionId = sessionId;
            return { stopReason: "end_turn" };
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const events = await collectEvents(
    manager.runTurn({
      handle: createHandle("oneshot-session", "oneshot-session:oneshot:1"),
      text: "hello",
      mode: "prompt",
      sessionMode: "oneshot",
      requestId: "req-oneshot",
    }),
  );

  assert.deepEqual(events, [{ type: "done", stopReason: "end_turn" }]);
  assert.equal(promptSessionId, "fresh-session");
  const saved = await store.load("oneshot-session:oneshot:1");
  assert.equal(saved?.acpSessionId, "fresh-session");
  assert.equal(saved?.agentSessionId, "fresh-agent");
});
