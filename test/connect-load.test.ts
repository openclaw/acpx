import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { QueueOwnerActiveSessionController } from "../src/queue-owner-turn-controller.js";
import { connectAndLoadSession } from "../src/session-runtime/connect-load.js";
import type { SessionRecord } from "../src/types.js";

type FakeClient = {
  hasReusableSession: (sessionId: string) => boolean;
  start: () => Promise<void>;
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
  supportsLoadSession: () => boolean;
  loadSessionWithOptions: (
    sessionId: string,
    cwd: string,
    options: { suppressReplayUpdates: boolean },
  ) => Promise<{ agentSessionId?: string }>;
  createSession: (cwd: string) => Promise<{ sessionId: string; agentSessionId?: string }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
};

const ACTIVE_CONTROLLER: QueueOwnerActiveSessionController = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionConfigOption: async () =>
    ({
      configOptions: [],
    }) as SetSessionConfigOptionResponse,
};

test("connectAndLoadSession resumes an existing load-capable session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });

    let clientAvailableCalls = 0;
    let connectedRecordCalls = 0;
    let resolvedSessionId: string | undefined;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        pid: 777,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async (sessionId, loadCwd, options) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(loadCwd, cwd);
        assert.deepEqual(options, { suppressReplayUpdates: true });
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        assert.equal(controller, ACTIVE_CONTROLLER);
      },
      onConnectedRecord: (connectedRecord) => {
        connectedRecordCalls += 1;
        assert.equal(connectedRecord.closed, false);
        assert.equal(connectedRecord.closedAt, undefined);
      },
      onSessionIdResolved: (sessionId) => {
        resolvedSessionId = sessionId;
      },
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(clientAvailableCalls, 1);
    assert.equal(connectedRecordCalls, 1);
    assert.equal(resolvedSessionId, "resume-session");
    assert.equal(record.pid, 777);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession falls back to createSession when load returns resource-not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "fallback-record",
      acpSessionId: "old-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async (createCwd) => {
        assert.equal(createCwd, cwd);
        return {
          sessionId: "new-session",
          agentSessionId: "new-runtime",
        };
      },
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.resumed, false);
    assert.equal(result.sessionId, "new-session");
    assert.equal(result.agentSessionId, "new-runtime");
    assert.match(result.loadError ?? "", /session not found/);
    assert.equal(record.acpSessionId, "new-session");
    assert.equal(record.agentSessionId, "new-runtime");
  });
});

test("connectAndLoadSession falls back to createSession for empty sessions on adapter internal errors", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "empty-record",
      acpSessionId: "empty-session",
      agentCommand: "agent",
      cwd,
      messages: [],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "internal error",
          },
        };
      },
      createSession: async () => ({
        sessionId: "created-for-empty",
        agentSessionId: "created-runtime",
      }),
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "created-for-empty");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "created-for-empty");
    assert.equal(record.agentSessionId, "created-runtime");
  });
});

test("connectAndLoadSession falls back to session/new on -32602 Invalid params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "invalid-params-record",
      acpSessionId: "invalid-params-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32602,
            message: "Invalid params",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fallback-from-32602",
        agentSessionId: "fallback-runtime",
      }),
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fallback-from-32602");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "fallback-from-32602");
  });
});

test("connectAndLoadSession falls back to session/new on -32601 Method not found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "method-not-found-record",
      acpSessionId: "method-not-found-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32601,
            message: "Method not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fallback-from-32601",
        agentSessionId: "fallback-runtime",
      }),
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fallback-from-32601");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "fallback-from-32601");
  });
});

test("connectAndLoadSession rethrows load failures that should not create a new session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "agent-history-record",
      acpSessionId: "agent-history-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "already responded" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "still broken",
          },
        };
      },
      createSession: async () => ({
        sessionId: "unexpected",
      }),
      setSessionMode: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert.deepEqual(error, {
          error: {
            code: -32603,
            message: "still broken",
          },
        });
        return true;
      },
    );
  });
});

test("connectAndLoadSession fails when desired mode replay cannot be restored on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "mode-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_mode_id: "plan",
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async (sessionId, modeId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modeId, "plan");
        throw new Error("mode restore rejected");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /Failed to replay saved session mode plan/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, undefined);
  });
});

test("connectAndLoadSession reuses an already loaded client session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "reused-record",
      acpSessionId: "reused-session",
      agentCommand: "agent",
      cwd,
    });

    let started = false;
    let loaded = false;
    const client: FakeClient = {
      hasReusableSession: (sessionId) => sessionId === "reused-session",
      start: async () => {
        started = true;
      },
      getAgentLifecycleSnapshot: () => ({
        pid: 888,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      loadSessionWithOptions: async () => {
        loaded = true;
        return {};
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(started, false);
    assert.equal(loaded, false);
    assert.equal(result.resumed, true);
    assert.equal(result.sessionId, "reused-session");
    assert.equal(record.pid, 888);
  });
});

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx,
  };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-connect-load-home-"));
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
