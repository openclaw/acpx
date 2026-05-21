import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModelState, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AcpxOperationalError } from "../src/errors.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { persistSessionOptions } from "../src/runtime/engine/session-options.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
} from "../src/runtime/public/contract.js";
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
  createSession: (cwd: string) => Promise<{
    sessionId: string;
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
  }>;
  loadSession: (
    sessionId: string,
    cwd: string,
  ) => Promise<{
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
  }>;
  hasReusableSession: (sessionId: string) => boolean;
  supportsLoadSession: () => boolean;
  supportsResumeSession?: () => boolean;
  resumeSession?: (
    sessionId: string,
    cwd: string,
  ) => Promise<{
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
  }>;
  supportsCloseSession?: () => boolean;
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
  closeSession?: (sessionId: string) => Promise<void>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
  requestCancelActivePrompt: () => Promise<boolean>;
  hasActivePrompt: () => boolean;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse | void>;
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

async function collectTurn(turn: AcpRuntimeTurn): Promise<{
  events: AcpRuntimeEvent[];
  result: AcpRuntimeTurnResult;
}> {
  const [events, result] = await Promise.all([collectEvents(turn.events), turn.result]);
  return { events, result };
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
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      },
      start: async () => {},
      close: async () => {},
      createSession: async (cwd) => {
        assert.equal(cwd, "/workspace");
        return {
          sessionId: "new-session",
          agentSessionId: "agent-session",
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              type: "select",
              currentValue: "ask",
              options: [{ value: "ask", name: "Ask" }],
            },
          ],
        };
      },
      loadSession: async () => {
        throw new Error("loadSession should not be called");
      },
      resumeSession: async (sessionId, cwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(cwd, "/workspace");
        return {
          agentSessionId: "resumed-agent",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "fast",
              options: [{ value: "fast", name: "Fast" }],
            },
          ],
        };
      },
      hasReusableSession: () => false,
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
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
  assert.deepEqual(
    created.acpx?.config_options?.map((option) => option.id),
    ["mode"],
  );
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
  assert.deepEqual(
    resumed.acpx?.config_options?.map((option) => option.id),
    ["model"],
  );
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
          supportsResumeSession: () => false,
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
    supportsResumeSession: () => false,
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

  const turn = manager.startTurn({
    handle: createHandle("turn-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-1",
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, [
    { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" },
    { type: "status", text: "write_file ok saved notes.md" },
  ]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });

  const saved = await store.load("turn-session");
  assert.equal(saved?.lastRequestId, "req-1");
  assert.equal(saved?.lastPromptAt != null, true);
  assert.equal(saved?.pid, 999);
  assert.equal(saved?.protocolVersion, 1);
});

test("AcpRuntimeManager keeps reusable persistent clients pooled across turns and closes them on runtime close", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "pooled-persistent-session",
    acpSessionId: "pooled-sid",
    agentCommand: "gemini --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let factoryCalls = 0;
  let closeCalls = 0;
  let promptCalls = 0;
  let handlers: FakeClientHandlers = {};
  const client: FakeClient = {
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { prompt: true },
    },
    start: async () => {},
    close: async () => {
      closeCalls += 1;
    },
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: (sessionId) => sessionId === "pooled-sid",
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "pooled-agent" }),
    getAgentLifecycleSnapshot: () => ({
      pid: 104_981,
      startedAt: "2026-01-01T00:00:00.000Z",
      running: true,
    }),
    prompt: async (sessionId) => {
      promptCalls += 1;
      assert.equal(sessionId, "pooled-sid");
      handlers.onSessionUpdate?.({
        sessionId: "pooled-sid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `turn ${promptCalls}` },
        },
      });
      return { stopReason: "end_turn" };
    },
    waitForSessionUpdatesIdle: async () => {},
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
      clientFactory: () => {
        factoryCalls += 1;
        return client as never;
      },
    },
  );

  const firstEvents = await collectEvents(
    manager.runTurn({
      handle: createHandle("pooled-persistent-session"),
      text: "first",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-pooled-1",
    }),
  );
  const secondEvents = await collectEvents(
    manager.runTurn({
      handle: createHandle("pooled-persistent-session"),
      text: "second",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-pooled-2",
    }),
  );

  assert.equal(factoryCalls, 1);
  assert.equal(promptCalls, 2);
  assert.equal(closeCalls, 0);
  assert.deepEqual(firstEvents, [
    { type: "text_delta", text: "turn 1", stream: "output", tag: "agent_message_chunk" },
    { type: "done", stopReason: "end_turn" },
  ]);
  assert.deepEqual(secondEvents, [
    { type: "text_delta", text: "turn 2", stream: "output", tag: "agent_message_chunk" },
    { type: "done", stopReason: "end_turn" },
  ]);

  await manager.close(createHandle("pooled-persistent-session"));

  assert.equal(closeCalls, 1);
  const closed = await store.load("pooled-persistent-session");
  assert.equal(closed?.closed, true);
  assert.equal(typeof closed?.closedAt, "string");
});

test("AcpRuntimeManager runTurn remains a compatibility adapter over startTurn", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "legacy-turn-session",
    acpSessionId: "legacy-turn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: (sessionId) => sessionId === "legacy-turn-sid",
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      handlers.onSessionUpdate?.({
        sessionId: "legacy-turn-sid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "legacy" },
        },
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
      handle: createHandle("legacy-turn-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-legacy",
    }),
  );

  assert.deepEqual(events, [
    { type: "text_delta", text: "legacy", stream: "output", tag: "agent_message_chunk" },
    { type: "done", stopReason: "end_turn" },
  ]);
});

test("AcpRuntimeManager retains a reusable persistent client across turns", async () => {
  const store = new InMemorySessionStore();
  let constructed = 0;
  let createSessionCalls = 0;
  let loadSessionCalls = 0;
  let promptCalls = 0;
  let closeCalls = 0;
  const promptSessionIds: string[] = [];

  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        constructed += 1;
        return {
          initializeResult: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
          start: async () => {},
          close: async () => {
            closeCalls += 1;
          },
          createSession: async () => {
            createSessionCalls += 1;
            return { sessionId: "pooled-persistent-sid", agentSessionId: "pooled-agent-id" };
          },
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: (sessionId: string) => sessionId === "pooled-persistent-sid",
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => {
            loadSessionCalls += 1;
            return { agentSessionId: "unexpected-load-agent-id" };
          },
          getAgentLifecycleSnapshot: () => ({
            pid: 1234,
            startedAt: "2026-01-01T00:00:00.000Z",
            running: true,
          }),
          prompt: async (sessionId: string) => {
            promptCalls += 1;
            promptSessionIds.push(sessionId);
            return { stopReason: "end_turn" };
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        } as never;
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "pooled-persistent-session",
    agent: "codex",
    mode: "persistent",
  });
  const handle = createHandle("pooled-persistent-session", record.acpxRecordId);

  for (const requestId of ["req-pooled-1", "req-pooled-2"]) {
    const turn = manager.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId,
    });
    const { events, result } = await collectTurn(turn);
    assert.deepEqual(events, []);
    assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  }

  assert.equal(constructed, 1);
  assert.equal(createSessionCalls, 1);
  assert.equal(loadSessionCalls, 0);
  assert.equal(promptCalls, 2);
  assert.deepEqual(promptSessionIds, ["pooled-persistent-sid", "pooled-persistent-sid"]);
  assert.equal(closeCalls, 0);

  await manager.close(handle);

  assert.equal(closeCalls, 1);
});

test("AcpRuntimeManager closeStream suppresses future live events while preserving terminal completion", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "stream-close-session",
    acpSessionId: "stream-close-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
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
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      resolvePromptStart();
      return await promptResult;
    },
    requestCancelActivePrompt: async () => false,
    hasActivePrompt: () => true,
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

  const turn = manager.startTurn({
    handle: createHandle("stream-close-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-close-stream",
  });
  const iterator = turn.events[Symbol.asyncIterator]();

  const firstEventPromise = iterator.next();
  await promptStarted;
  handlers.onSessionUpdate?.({
    sessionId: "stream-close-sid",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "visible" },
    },
  });

  assert.deepEqual(await firstEventPromise, {
    done: false,
    value: { type: "text_delta", text: "visible", stream: "output", tag: "agent_message_chunk" },
  });

  await turn.closeStream({
    reason: "observer closed stream",
  });

  handlers.onSessionUpdate?.({
    sessionId: "stream-close-sid",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "suppressed" },
    },
  });
  resolvePrompt({ stopReason: "end_turn" });

  assert.deepEqual(await iterator.next(), {
    done: true,
    value: undefined,
  });
  assert.deepEqual(await turn.result, {
    status: "completed",
    stopReason: "end_turn",
  });
  assert.deepEqual(await iterator.next(), {
    done: true,
    value: undefined,
  });
});

test("AcpRuntimeManager does not pool a persistent client after active close", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "active-close-session",
    acpSessionId: "active-close-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let closeCalls = 0;
  let promptActive = false;
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
    close: async () => {
      closeCalls += 1;
      promptActive = false;
    },
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: (sessionId) => sessionId === "active-close-sid",
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "active-close-agent-id" }),
    getAgentLifecycleSnapshot: () => ({ running: promptActive }),
    prompt: async () => {
      promptActive = true;
      resolvePromptStart();
      return await promptResult;
    },
    requestCancelActivePrompt: async () => true,
    hasActivePrompt: () => promptActive,
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
  const handle = createHandle("active-close-session");

  const turn = manager.startTurn({
    handle,
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-active-close",
  });
  const eventsPromise = collectEvents(turn.events);
  await promptStarted;

  await manager.close(handle);

  let closed = await store.load("active-close-session");
  assert.equal(closed?.closed, true);
  assert.equal(closeCalls, 0);

  resolvePrompt({ stopReason: "cancelled" });

  const events = await eventsPromise;
  const result = await turn.result;
  closed = await store.load("active-close-session");

  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "cancelled", stopReason: "cancelled" });
  assert.equal(closeCalls, 1);
  assert.equal(closed?.closed, true);
  assert.equal(typeof closed?.closedAt, "string");
});

test("AcpRuntimeManager live checkpoints preserve active close state", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "active-close-checkpoint-session",
    acpSessionId: "active-close-checkpoint-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  let promptActive = false;
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
    close: async () => {
      promptActive = false;
    },
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: (sessionId) => sessionId === "active-close-checkpoint-sid",
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    supportsCloseSession: () => true,
    closeSession: async () => {},
    loadSessionWithOptions: async () => ({ agentSessionId: "active-close-checkpoint-agent-id" }),
    getAgentLifecycleSnapshot: () => ({ running: promptActive }),
    prompt: async () => {
      promptActive = true;
      handlers.onSessionUpdate?.({
        sessionId: "active-close-checkpoint-sid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live checkpoint" },
        },
      });
      resolvePromptStart();
      return await promptResult;
    },
    requestCancelActivePrompt: async () => {
      promptActive = false;
      return true;
    },
    hasActivePrompt: () => promptActive,
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
  const handle = createHandle("active-close-checkpoint-session");

  const turn = manager.startTurn({
    handle,
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-active-close-checkpoint",
  });
  const eventsPromise = collectEvents(turn.events);
  await promptStarted;

  await manager.close(handle, { discardPersistentState: true });
  await new Promise((resolve) => setTimeout(resolve, 650));

  const checkpointed = await store.load("active-close-checkpoint-session");
  assert.equal(checkpointed?.closed, true);
  assert.equal(checkpointed?.acpx?.reset_on_next_ensure, true);

  resolvePrompt({ stopReason: "cancelled" });
  await eventsPromise;
  await turn.result;
});

test("AcpRuntimeManager accepts a session reply even when the prompt RPC times out", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "late-reply-session",
    acpSessionId: "late-reply-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: () => true,
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      setTimeout(() => {
        handlers.onSessionUpdate?.({
          sessionId: "late-reply-sid",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "late reply" },
          },
        });
      }, 5);
      return await new Promise<{ stopReason: string }>(() => {});
    },
    requestCancelActivePrompt: async () => false,
    hasActivePrompt: () => true,
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

  const turn = manager.startTurn({
    handle: createHandle("late-reply-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-late-reply",
    timeoutMs: 20,
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, [
    { type: "text_delta", text: "late reply", stream: "output", tag: "agent_message_chunk" },
  ]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
});

test("AcpRuntimeManager waits for late reply chunks to settle before ending a salvaged turn", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "late-reply-stream-session",
    acpSessionId: "late-reply-stream-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let handlers: FakeClientHandlers = {};
  let lastUpdateAt = Date.now();
  const client: FakeClient = {
    start: async () => {},
    close: async () => {},
    createSession: async () => ({ sessionId: "unused" }),
    loadSession: async () => ({ agentSessionId: "unused" }),
    hasReusableSession: () => true,
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    prompt: async () => {
      setTimeout(() => {
        lastUpdateAt = Date.now();
        handlers.onSessionUpdate?.({
          sessionId: "late-reply-stream-sid",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "late" },
          },
        });
      }, 5);
      setTimeout(() => {
        lastUpdateAt = Date.now();
        handlers.onSessionUpdate?.({
          sessionId: "late-reply-stream-sid",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " reply" },
          },
        });
      }, 300);
      return await new Promise<{ stopReason: string }>(() => {});
    },
    requestCancelActivePrompt: async () => false,
    hasActivePrompt: () => true,
    waitForSessionUpdatesIdle: async ({ idleMs = 0, timeoutMs = 0 } = {}) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        if (Date.now() - lastUpdateAt >= idleMs) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("timed out waiting for session updates to go idle");
    },
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

  const turn = manager.startTurn({
    handle: createHandle("late-reply-stream-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-late-reply-stream",
    timeoutMs: 20,
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, [
    { type: "text_delta", text: "late", stream: "output", tag: "agent_message_chunk" },
    { type: "text_delta", text: " reply", stream: "output", tag: "agent_message_chunk" },
  ]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
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
    supportsResumeSession: () => false,
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
      return {
        configOptions: [
          {
            id: "approval",
            name: "Approval",
            type: "select",
            currentValue: "manual",
            options: [{ value: "manual", name: "Manual" }],
          },
        ],
      };
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

  const turn = manager.startTurn({
    handle: createHandle("live-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-live",
  });
  const eventsPromise = collectEvents(turn.events);
  await promptStarted;
  await manager.setMode(createHandle("live-session"), "plan");
  await manager.setConfigOption(createHandle("live-session"), "approval", "manual");
  const liveStatusDuringTurn = await manager.getStatus(createHandle("live-session"));
  await turn.cancel();
  const events = await eventsPromise;
  const result = await turn.result;
  const liveStatusAfterTurn = await manager.getStatus(createHandle("live-session"));

  assert.equal(setModeCalls, 1);
  assert.equal(setConfigCalls, 1);
  const expectedConfigOptions = [
    {
      id: "approval",
      name: "Approval",
      type: "select",
      currentValue: "manual",
      options: [{ value: "manual", name: "Manual" }],
    },
  ];
  assert.deepEqual(liveStatusDuringTurn.details?.configOptions, expectedConfigOptions);
  assert.deepEqual(liveStatusAfterTurn.details?.configOptions, expectedConfigOptions);
  assert.equal(cancelRequested, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "cancelled", stopReason: "cancelled" });
  assert.equal(handlers.onSessionUpdate, undefined);
});

test("AcpRuntimeManager rejects unsupported advertised config option keys after refresh", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "config-key-session",
    acpSessionId: "config-key-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
    acpx: {
      config_options: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }],
        },
      ],
    },
  });
  const store = new InMemorySessionStore([record]);
  let setConfigCalls = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "medium",
                options: [{ value: "medium", name: "Medium" }],
              },
            ],
          }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "medium",
                options: [{ value: "medium", name: "Medium" }],
              },
            ],
          }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {
            setConfigCalls += 1;
            throw new Error("unsupported config keys should not reach the adapter");
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  await assert.rejects(
    async () =>
      await manager.setConfigOption(createHandle("config-key-session"), "timeoutSeconds", "180"),
    /does not advertise config option 'timeoutSeconds'.*Supported config options: effort/,
  );
  assert.equal(setConfigCalls, 0);
});

test("AcpRuntimeManager maps generic thinking config to refreshed advertised effort key", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "thinking-alias-session",
    acpSessionId: "thinking-alias-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
    acpx: {
      config_options: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
      ],
    },
  });
  const store = new InMemorySessionStore([record]);
  const setConfigCalls: Array<{ sessionId: string; key: string; value: string }> = [];
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({
            agentSessionId: "unused",
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "medium",
                options: [{ value: "high", name: "High" }],
              },
            ],
          }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async (sessionId: string, key: string, value: string) => {
            setConfigCalls.push({ sessionId, key, value });
            return {
              configOptions: [
                {
                  id: "effort",
                  name: "Effort",
                  type: "select",
                  currentValue: value,
                  options: [{ value, name: "High" }],
                },
              ],
            };
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  await manager.setConfigOption(createHandle("thinking-alias-session"), "thinking", "high");

  assert.deepEqual(setConfigCalls, [
    {
      sessionId: "thinking-alias-backend-session",
      key: "effort",
      value: "high",
    },
  ]);
  const stored = await store.load("thinking-alias-session");
  assert.deepEqual(stored?.acpx?.desired_config_options, { effort: "high" });
});

test("AcpRuntimeManager maps active generic thinking config against live advertised effort key", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "active-thinking-alias-session",
    acpSessionId: "active-thinking-alias-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
    acpx: {
      config_options: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
      ],
    },
  });
  const store = new InMemorySessionStore([record]);
  const setConfigCalls: Array<{ sessionId: string; key: string; value: string }> = [];
  let resolvePromptStart!: () => void;
  let resolvePrompt!: (value: { stopReason: string }) => void;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStart = resolve;
  });
  const promptResult = new Promise<{ stopReason: string }>((resolve) => {
    resolvePrompt = resolve;
  });
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({
            agentSessionId: "unused",
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                type: "select",
                currentValue: "medium",
                options: [{ value: "high", name: "High" }],
              },
            ],
          }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => {
            resolvePromptStart();
            return await promptResult;
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => true,
          setSessionMode: async () => {},
          setSessionConfigOption: async (sessionId: string, key: string, value: string) => {
            setConfigCalls.push({ sessionId, key, value });
            return {
              configOptions: [
                {
                  id: "effort",
                  name: "Effort",
                  type: "select",
                  currentValue: value,
                  options: [{ value, name: "High" }],
                },
              ],
            };
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const handle = createHandle("active-thinking-alias-session");
  const turn = manager.startTurn({
    handle,
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-active-thinking-alias",
  });
  const eventsPromise = collectEvents(turn.events);
  await promptStarted;
  await manager.setConfigOption(handle, "thinking", "high");
  resolvePrompt({ stopReason: "end_turn" });
  const result = await turn.result;
  const events = await eventsPromise;

  assert.deepEqual(setConfigCalls, [
    {
      sessionId: "active-thinking-alias-backend-session",
      key: "effort",
      value: "high",
    },
  ]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  assert.deepEqual(events, []);
});

test("AcpRuntimeManager waits for active load refresh before resolving generic config keys", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "loading-thinking-alias-session",
    acpSessionId: "loading-thinking-alias-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
    acpx: {
      config_options: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
      ],
    },
  });
  const store = new InMemorySessionStore([record]);
  const setConfigCalls: Array<{ sessionId: string; key: string; value: string }> = [];
  let resolveLoadStarted!: () => void;
  let resolveLoad!: () => void;
  let resolvePrompt!: (value: { stopReason: string }) => void;
  const loadStarted = new Promise<void>((resolve) => {
    resolveLoadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const promptResult = new Promise<{ stopReason: string }>((resolve) => {
    resolvePrompt = resolve;
  });
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => {
            resolveLoadStarted();
            await loadGate;
            return {
              agentSessionId: "unused",
              configOptions: [
                {
                  id: "effort",
                  name: "Effort",
                  type: "select",
                  currentValue: "medium",
                  options: [{ value: "high", name: "High" }],
                },
              ],
            };
          },
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => await promptResult,
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async (sessionId: string, key: string, value: string) => {
            setConfigCalls.push({ sessionId, key, value });
            return {
              configOptions: [
                {
                  id: "effort",
                  name: "Effort",
                  type: "select",
                  currentValue: value,
                  options: [{ value, name: "High" }],
                },
              ],
            };
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );

  const handle = createHandle("loading-thinking-alias-session");
  const turn = manager.startTurn({
    handle,
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-loading-thinking-alias",
  });
  const eventsPromise = collectEvents(turn.events);
  await loadStarted;
  const setPromise = manager.setConfigOption(handle, "thinking", "high");
  resolveLoad();
  await setPromise;
  resolvePrompt({ stopReason: "end_turn" });
  const result = await turn.result;
  const events = await eventsPromise;

  assert.deepEqual(setConfigCalls, [
    {
      sessionId: "loading-thinking-alias-backend-session",
      key: "effort",
      value: "high",
    },
  ]);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  assert.deepEqual(events, []);
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
    supportsResumeSession: () => false,
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

  const turn = manager.startTurn({
    handle: createHandle("fallback-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "oneshot",
    requestId: "req-fallback",
  });
  const eventsPromise = collectEvents(turn.events);
  const setModePromise = manager.setMode(createHandle("fallback-session"), "plan", "oneshot");
  resolveLoadFailure();
  await setModePromise;
  await promptStarted;
  await turn.cancel();
  const events = await eventsPromise;
  const result = await turn.result;

  assert.equal(setModeSessionId, "fresh-session");
  assert.equal(promptSessionId, "fresh-session");
  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "cancelled", stopReason: "cancelled" });
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
    supportsResumeSession: () => false,
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

  const turn = manager.startTurn({
    handle: createHandle("aborted-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "oneshot",
    requestId: "req-abort",
    signal: controller.signal,
  });
  const eventsPromise = collectEvents(turn.events);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  resolveLoadFailure();
  const events = await eventsPromise;
  const result = await turn.result;

  assert.equal(promptCalled, false);
  assert.equal(cancelCalls, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "cancelled", stopReason: "cancelled" });
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
          supportsResumeSession: () => false,
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

test("AcpRuntimeManager closes the backend session when discarding persistent state", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "discard-session",
    acpSessionId: "discard-sid",
    agentCommand: "claude --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let startCalls = 0;
  let closeCalls = 0;
  const closedSessionIds: string[] = [];
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {
            startCalls += 1;
          },
          close: async () => {
            closeCalls += 1;
          },
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          supportsCloseSession: () => true,
          closeSession: async (sessionId: string) => {
            closedSessionIds.push(sessionId);
          },
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

  await manager.close(createHandle("discard-session"), {
    discardPersistentState: true,
  });

  assert.equal(startCalls, 1);
  assert.equal(closeCalls, 1);
  assert.deepEqual(closedSessionIds, ["discard-sid"]);
  const closed = await store.load("discard-session");
  assert.equal(closed?.closed, true);
  assert.equal(typeof closed?.closedAt, "string");
  assert.equal(closed?.acpx?.reset_on_next_ensure, true);

  let recreatedSessions = 0;
  const restartedManager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {},
          close: async () => {},
          createSession: async () => {
            recreatedSessions += 1;
            return { sessionId: "fresh-discard-sid", agentSessionId: "fresh-agent" };
          },
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          supportsCloseSession: () => true,
          closeSession: async () => {},
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

  const recreated = await restartedManager.ensureSession({
    sessionKey: "discard-session",
    agent: "claude",
    mode: "persistent",
    cwd: "/workspace",
  });

  assert.equal(recreatedSessions, 1);
  assert.equal(recreated.acpSessionId, "fresh-discard-sid");
  assert.equal(recreated.agentSessionId, "fresh-agent");
  assert.equal(recreated.messages.length, 0);
  assert.equal(recreated.acpx?.reset_on_next_ensure, undefined);
});

test("AcpRuntimeManager treats missing backend sessions as a successful discard reset", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "discard-missing-session",
    acpSessionId: "missing-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let startCalls = 0;
  let closeCalls = 0;
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          start: async () => {
            startCalls += 1;
          },
          close: async () => {
            closeCalls += 1;
          },
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          supportsCloseSession: () => true,
          closeSession: async () => {
            throw { error: { code: -32002, message: "session not found" } };
          },
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

  await manager.close(createHandle("discard-missing-session"), {
    discardPersistentState: true,
  });

  assert.equal(startCalls, 1);
  assert.equal(closeCalls, 1);
  const closed = await store.load("discard-missing-session");
  assert.equal(closed?.closed, true);
  assert.equal(typeof closed?.closedAt, "string");
  assert.equal(closed?.acpx?.reset_on_next_ensure, true);
});

test("AcpRuntimeManager applies timeoutMs to backend session shutdown during discard reset", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "discard-timeout-session",
    acpSessionId: "slow-backend-session",
    agentCommand: "claude --acp",
    cwd: "/workspace",
  });
  const store = new InMemorySessionStore([record]);
  let startCalls = 0;
  let closeCalls = 0;
  let closeSessionCalls = 0;
  const never = new Promise<void>(() => {});
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store, timeoutMs: 5 }),
    {
      clientFactory: () =>
        ({
          start: async () => {
            startCalls += 1;
          },
          close: async () => {
            closeCalls += 1;
          },
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          supportsCloseSession: () => true,
          closeSession: async () => {
            closeSessionCalls += 1;
            await never;
          },
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
      await manager.close(createHandle("discard-timeout-session"), {
        discardPersistentState: true,
      }),
    /Timed out after 5ms/,
  );

  assert.equal(startCalls, 1);
  assert.equal(closeSessionCalls, 1);
  assert.equal(closeCalls, 1);
  const unchanged = await store.load("discard-timeout-session");
  assert.equal(unchanged?.closed, false);
  assert.equal(unchanged?.closedAt, undefined);
  assert.equal(unchanged?.acpx?.reset_on_next_ensure, undefined);
});

test("AcpRuntimeManager fails offline persistent controls clearly when session reuse is unavailable", async () => {
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
          supportsResumeSession: () => false,
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
    /Persistent ACP session offline-persistent-backend-session could not be resumed: agent does not support session\/resume or session\/load/,
  );
  await assert.rejects(
    async () =>
      await manager.setConfigOption(
        createHandle("offline-persistent-session"),
        "approval",
        "manual",
      ),
    /Persistent ACP session offline-persistent-backend-session could not be resumed: agent does not support session\/resume or session\/load/,
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
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => {
            throw new AcpxOperationalError("prompt exploded", {
              outputCode: "RUNTIME",
              detailCode: "AGENT_DISCONNECTED",
              origin: "acp",
              retryable: true,
            });
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

  const turn = manager.startTurn({
    handle: createHandle("error-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-error",
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, []);
  assert.deepEqual(result, {
    status: "failed",
    error: {
      code: "RUNTIME",
      detailCode: "AGENT_DISCONNECTED",
      message: "prompt exploded",
      retryable: true,
    },
  });
  const legacyEvents = await collectEvents(
    manager.runTurn({
      handle: createHandle("error-session"),
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-error-legacy",
    }),
  );
  assert.deepEqual(legacyEvents, [
    {
      type: "error",
      code: "RUNTIME",
      detailCode: "AGENT_DISCONNECTED",
      message: "prompt exploded",
      retryable: true,
    },
  ]);
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
          supportsResumeSession: () => false,
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

  assert.throws(
    () =>
      manager.startTurn({
        handle: createHandle("attachment-session"),
        text: "",
        attachments: [{ mediaType: "application/pdf", data: "Zm9v" }],
        mode: "prompt",
        sessionMode: "persistent",
        requestId: "req-attachment",
      }),
    /Unsupported ACP runtime attachment media type: application\/pdf/,
  );
});

test("AcpRuntimeManager fails persistent turns clearly when session reuse is unavailable", async () => {
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
          supportsResumeSession: () => false,
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

  const turn = manager.startTurn({
    handle: createHandle("persistent-session"),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-persistent",
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, []);
  assert.deepEqual(result, {
    status: "failed",
    error: {
      code: "RUNTIME",
      detailCode: "SESSION_RESUME_REQUIRED",
      message:
        "Persistent ACP session persistent-backend-session could not be resumed: agent does not support session/resume or session/load",
      retryable: true,
    },
  });
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
          supportsResumeSession: () => false,
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

  const turn = manager.startTurn({
    handle: createHandle("oneshot-session", "oneshot-session:oneshot:1"),
    text: "hello",
    mode: "prompt",
    sessionMode: "oneshot",
    requestId: "req-oneshot",
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  assert.equal(promptSessionId, "fresh-session");
  const saved = await store.load("oneshot-session:oneshot:1");
  assert.equal(saved?.acpSessionId, "fresh-session");
  assert.equal(saved?.agentSessionId, "fresh-agent");
});

test("AcpRuntimeManager falls back when a kept-open persistent client is no longer reusable", async () => {
  const store = new InMemorySessionStore();
  let firstClientReusable = true;
  let firstClientCloseCalls = 0;
  let firstClientPromptCalls = 0;
  let secondClientPromptCalls = 0;
  let constructed = 0;

  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        constructed += 1;
        if (constructed === 1) {
          return {
            start: async () => {},
            close: async () => {
              firstClientCloseCalls += 1;
            },
            createSession: async () => ({
              sessionId: "pending-session-id",
              agentSessionId: "pending-agent-id",
            }),
            loadSession: async () => ({ agentSessionId: "unused" }),
            hasReusableSession: () => firstClientReusable,
            supportsLoadSession: () => true,
            supportsResumeSession: () => false,
            loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
            getAgentLifecycleSnapshot: () => ({ running: firstClientReusable }),
            prompt: async () => {
              firstClientPromptCalls += 1;
              return { stopReason: "end_turn" };
            },
            requestCancelActivePrompt: async () => false,
            hasActivePrompt: () => false,
            setSessionMode: async () => {},
            setSessionConfigOption: async () => {},
            clearEventHandlers: () => {},
            setEventHandlers: () => {},
          } as never;
        }

        return {
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "unused" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "resumed-agent-id" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => {
            secondClientPromptCalls += 1;
            return { stopReason: "end_turn" };
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        } as never;
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "pending-persistent-session",
    agent: "codex",
    mode: "persistent",
  });
  firstClientReusable = false;

  const turn = manager.startTurn({
    handle: createHandle("pending-persistent-session", record.acpxRecordId),
    text: "hello",
    mode: "prompt",
    sessionMode: "persistent",
    requestId: "req-pending-persistent-session",
  });
  const { events, result } = await collectTurn(turn);

  assert.deepEqual(events, []);
  assert.deepEqual(result, { status: "completed", stopReason: "end_turn" });
  assert.equal(firstClientCloseCalls, 1);
  assert.equal(firstClientPromptCalls, 0);
  assert.equal(secondClientPromptCalls, 1);
  assert.equal(constructed, 2);
});

test("AcpRuntimeManager reuses a kept-open persistent client for controls before the first turn", async () => {
  const store = new InMemorySessionStore();
  let constructed = 0;
  let createSessionCalls = 0;
  let loadSessionCalls = 0;
  let promptCalls = 0;
  let closeCalls = 0;
  const setModeSessions: string[] = [];
  const setConfigCalls: Array<{ sessionId: string; key: string; value: string }> = [];

  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        constructed += 1;
        return {
          start: async () => {},
          close: async () => {
            closeCalls += 1;
          },
          createSession: async () => {
            createSessionCalls += 1;
            return {
              sessionId: "pending-session-id",
              agentSessionId: "pending-agent-id",
            };
          },
          loadSession: async () => {
            loadSessionCalls += 1;
            return { agentSessionId: "unexpected-agent-id" };
          },
          hasReusableSession: (sessionId: string) => sessionId === "pending-session-id",
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => {
            loadSessionCalls += 1;
            return { agentSessionId: "unexpected-agent-id" };
          },
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async (sessionId: string) => {
            promptCalls += 1;
            assert.equal(sessionId, "pending-session-id");
            return { stopReason: "end_turn" };
          },
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async (sessionId: string, modeId: string) => {
            assert.equal(modeId, "auto");
            setModeSessions.push(sessionId);
          },
          setSessionConfigOption: async (sessionId: string, key: string, value: string) => {
            setConfigCalls.push({ sessionId, key, value });
            return {
              configOptions: [
                {
                  id: key,
                  name: "Approval",
                  type: "select",
                  currentValue: value,
                  options: [{ value, name: "Manual" }],
                },
              ],
            };
          },
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        } as never;
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "pending-control-session",
    agent: "codex",
    mode: "persistent",
  });
  const handle = createHandle("pending-control-session", record.acpxRecordId);

  await manager.setMode(handle, "auto");
  await manager.setConfigOption(handle, "approval", "manual");
  const status = await manager.getStatus(handle);
  const events = await collectEvents(
    manager.runTurn({
      handle,
      text: "hello",
      mode: "prompt",
      sessionMode: "persistent",
      requestId: "req-pending-control-session",
    }),
  );

  assert.deepEqual(events, [{ type: "done", stopReason: "end_turn" }]);
  assert.equal(constructed, 1);
  assert.equal(createSessionCalls, 1);
  assert.equal(loadSessionCalls, 0);
  assert.equal(promptCalls, 1);
  assert.deepEqual(setModeSessions, ["pending-session-id"]);
  assert.deepEqual(setConfigCalls, [
    {
      sessionId: "pending-session-id",
      key: "approval",
      value: "manual",
    },
  ]);
  assert.deepEqual(status.details?.configOptions, [
    {
      id: "approval",
      name: "Approval",
      type: "select",
      currentValue: "manual",
      options: [{ value: "manual", name: "Manual" }],
    },
  ]);
  assert.deepEqual(store.records.get(record.acpxRecordId)?.acpx?.desired_config_options, {
    approval: "manual",
  });
  assert.equal(closeCalls, 0);

  await manager.close(handle);

  assert.equal(closeCalls, 1);
});

function createModelsClientFactory(options: {
  models?: SessionModelState;
  onSetSessionModel?: (sessionId: string, modelId: string) => void;
}): () => FakeClient {
  return (): FakeClient =>
    ({
      initializeResult: { protocolVersion: 1 },
      start: async () => {},
      close: async () => {},
      createSession: async () => ({
        sessionId: "models-session",
        agentSessionId: "models-agent",
        ...(options.models !== undefined ? { models: options.models } : {}),
      }),
      loadSession: async () => ({ agentSessionId: "models-agent" }),
      hasReusableSession: () => false,
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => ({ agentSessionId: "models-agent" }),
      getAgentLifecycleSnapshot: () => ({ pid: 1, startedAt: "now", running: true }),
      prompt: async () => ({ stopReason: "end_turn" }),
      requestCancelActivePrompt: async () => false,
      hasActivePrompt: () => false,
      setSessionMode: async () => {},
      setSessionConfigOption: async () => {},
      setSessionModel: async (sessionId: string, modelId: string) => {
        options.onSetSessionModel?.(sessionId, modelId);
      },
      clearEventHandlers: () => {},
      setEventHandlers: () => {},
    }) as unknown as FakeClient;
}

test("AcpRuntimeManager getStatus surfaces models advertised by the agent", async () => {
  const store = new InMemorySessionStore();
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp", sessionStore: store }),
    {
      clientFactory: createModelsClientFactory({
        models: {
          currentModelId: "opus",
          availableModels: [
            { modelId: "opus", name: "Opus" },
            { modelId: "sonnet", name: "Sonnet" },
          ],
        },
      }) as never,
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "models-key",
    agent: "claude",
    mode: "persistent",
  });
  const handle = createHandle(record.acpxRecordId);
  const status = await manager.getStatus(handle);

  assert.deepEqual(status.models, {
    currentModelId: "opus",
    availableModelIds: ["opus", "sonnet"],
  });
});

test("AcpRuntimeManager getStatus omits models when the agent did not advertise any", async () => {
  const store = new InMemorySessionStore();
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp", sessionStore: store }),
    {
      clientFactory: createModelsClientFactory({}) as never,
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "no-models-key",
    agent: "claude",
    mode: "persistent",
  });
  const handle = createHandle(record.acpxRecordId);
  const status = await manager.getStatus(handle);

  assert.equal(status.models, undefined);
});

test("AcpRuntimeManager getStatus.models survives a save/reload cycle", async () => {
  const store = new InMemorySessionStore();
  const factory = createModelsClientFactory({
    models: {
      currentModelId: "opus",
      availableModels: [
        { modelId: "opus", name: "Opus" },
        { modelId: "sonnet", name: "Sonnet" },
      ],
    },
  }) as never;

  const initial = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp", sessionStore: store }),
    { clientFactory: factory },
  );
  const record = await initial.ensureSession({
    sessionKey: "persisted-models-key",
    agent: "claude",
    mode: "persistent",
  });
  const handle = createHandle(record.acpxRecordId);
  const beforeStatus = await initial.getStatus(handle);
  assert.deepEqual(beforeStatus.models, {
    currentModelId: "opus",
    availableModelIds: ["opus", "sonnet"],
  });

  const reloaded = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp", sessionStore: store }),
    { clientFactory: factory },
  );
  const afterStatus = await reloaded.getStatus(handle);
  assert.deepEqual(afterStatus.models, beforeStatus.models);
});

test("AcpRuntimeManager forwards sessionOptions to createClient on fresh session", async () => {
  const store = new InMemorySessionStore();
  const factoryCalls: Array<Record<string, unknown>> = [];
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: (options) => {
        factoryCalls.push(options as Record<string, unknown>);
        return {
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          start: async () => {},
          close: async () => {},
          createSession: async () => ({ sessionId: "new-sid", agentSessionId: "agent-sid" }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        } as never;
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "system-prompt-session",
    agent: "codex",
    mode: "persistent",
    sessionOptions: { systemPrompt: "Be terse." },
  });

  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0]?.sessionOptions, { systemPrompt: "Be terse." });
  assert.deepEqual(record.acpx?.session_options, {
    model: undefined,
    allowed_tools: undefined,
    max_turns: undefined,
    system_prompt: "Be terse.",
  });
});

test("AcpRuntimeManager persists sessionOptions { append } and model/allowedTools/maxTurns", async () => {
  const store = new InMemorySessionStore();
  const factoryCalls: Array<Record<string, unknown>> = [];
  const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: (options) => {
        factoryCalls.push(options as Record<string, unknown>);
        return {
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          start: async () => {},
          close: async () => {},
          createSession: async () => ({
            sessionId: "new-sid",
            agentSessionId: "agent-sid",
            models: {
              currentModelId: "default",
              availableModels: [
                { modelId: "default", name: "Default" },
                { modelId: "fast", name: "Fast" },
              ],
            },
          }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionModel: async (sessionId: string, modelId: string) => {
            setModelCalls.push({ sessionId, modelId });
          },
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        } as never;
      },
    },
  );

  const sessionOptions = {
    systemPrompt: { append: "Also review tests." },
    model: "fast",
    allowedTools: ["read", "edit"],
    maxTurns: 5,
  };
  const record = await manager.ensureSession({
    sessionKey: "append-session",
    agent: "codex",
    mode: "persistent",
    sessionOptions,
  });

  assert.deepEqual(factoryCalls[0]?.sessionOptions, sessionOptions);
  assert.deepEqual(setModelCalls, [{ sessionId: "new-sid", modelId: "fast" }]);
  assert.equal(record.acpx?.current_model_id, "fast");
  assert.deepEqual(record.acpx?.available_models, ["default", "fast"]);
  assert.deepEqual(record.acpx?.session_options, {
    model: "fast",
    allowed_tools: ["read", "edit"],
    max_turns: 5,
    system_prompt: { append: "Also review tests." },
  });
});

test("persistSessionOptions preserves an explicit empty allowedTools list", () => {
  const record = makeSessionRecord({
    acpxRecordId: "empty-tools-session",
    acpSessionId: "empty-tools-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
  });

  persistSessionOptions(record, { allowedTools: [] });

  assert.deepEqual(record.acpx?.session_options, {
    model: undefined,
    allowed_tools: [],
    max_turns: undefined,
    system_prompt: undefined,
  });
});

test("AcpRuntimeManager ignores sessionOptions when reusing an existing persistent record", async () => {
  const existing = makeSessionRecord({
    acpxRecordId: "reuse-key",
    acpSessionId: "sid-existing",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    closed: true,
    closedAt: "2026-01-01T00:05:00.000Z",
  });
  const store = new InMemorySessionStore([existing]);
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () => {
        throw new Error("clientFactory should not be called when reusing");
      },
    },
  );

  const record = await manager.ensureSession({
    sessionKey: "reuse-key",
    agent: "codex",
    mode: "persistent",
    cwd: "/workspace",
    sessionOptions: { systemPrompt: "ignored" },
  });

  assert.equal(record.acpSessionId, "sid-existing");
  assert.equal(record.acpx?.session_options, undefined);
});
