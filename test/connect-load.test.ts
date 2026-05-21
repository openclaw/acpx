import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SessionModelState, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  connectAndLoadSession,
  type ConnectedSessionController,
} from "../src/runtime/engine/reconnect.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
} from "./runtime-test-helpers.js";

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
  supportsResumeSession?: () => boolean;
  resumeSession?: (
    sessionId: string,
    cwd: string,
  ) => Promise<{ agentSessionId?: string; models?: SessionModelState }>;
  loadSessionWithOptions: (
    sessionId: string,
    cwd: string,
    options: { suppressReplayUpdates: boolean },
  ) => Promise<{ agentSessionId?: string; models?: SessionModelState }>;
  createSession: (cwd: string) => Promise<{
    sessionId: string;
    agentSessionId?: string;
    models?: SessionModelState;
  }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  setSessionConfigOption?: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

const ACTIVE_CONTROLLER: ConnectedSessionController & {
  setSessionModel: (modelId: string) => Promise<void>;
} = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () =>
    ({
      configOptions: [],
    }) as SetSessionConfigOptionResponse,
};

function buildModelsState(currentModelId: string): SessionModelState {
  return {
    currentModelId,
    availableModels: [
      { modelId: "default-model", name: "default-model" },
      { modelId: "gpt-5.4", name: "gpt-5.4" },
    ],
  };
}

test("connectAndLoadSession prefers session/resume for resume-capable sessions", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return { agentSessionId: "runtime-session" };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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

test("connectAndLoadSession fails instead of creating a fresh session when resume policy requires the same session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "strict-resume-record",
      acpSessionId: "strict-resume-session",
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
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session strict-resume-session could not be resumed: .*session not found/i,
    );

    assert.equal(record.acpSessionId, "strict-resume-session");
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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

test("connectAndLoadSession fails clearly when same-session resume is required but session reuse is unsupported", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "unsupported-load-record",
      acpSessionId: "unsupported-load-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session unsupported-load-session could not be resumed: agent does not support session\/resume or session\/load/i,
    );
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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
      agentSessionId: "stale-runtime",
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
      supportsResumeSession: () => false,
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
      setSessionModel: async () => {},
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
        assert.equal(error.name, "SessionModeReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session mode plan/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
  });
});

test("connectAndLoadSession replays desired model on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    let setModelCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
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
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        setModelCalls += 1;
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.equal(setModelCalls, 1);
    assert.equal(record.acpSessionId, "fresh-session");
    assert.equal(record.acpx?.current_model_id, "gpt-5.4");
    assert.deepEqual(record.acpx?.available_models, ["default-model", "gpt-5.4"]);
  });
});

test("connectAndLoadSession fails clearly when saved model cannot be replayed generically", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-unsupported-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {
        throw new Error("setSessionModel should not be called");
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
        assert.equal(error.name, "SessionModelReplayError");
        assert.match(error.message, /did not advertise model support/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
  });
});

test("connectAndLoadSession restores the original session when desired model replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
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
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
        throw new Error("model restore rejected");
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
        assert.equal(error.name, "SessionModelReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session model gpt-5\.4/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
    assert.equal(record.acpx?.current_model_id, undefined);
  });
});

test("connectAndLoadSession replays desired config options on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          reasoning_effort: "high",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
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
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        return { configOptions: [] };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.deepEqual(configCalls, [
      {
        sessionId: "fresh-session",
        configId: "reasoning_effort",
        value: "high",
      },
    ]);
  });
});

test("connectAndLoadSession restores the original session when desired config replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          reasoning_effort: "xhigh",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
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
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(configId, "reasoning_effort");
        assert.equal(value, "xhigh");
        throw new Error("config restore rejected");
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
        assert.equal(error.name, "SessionConfigOptionReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(
          error.message,
          /Failed to replay saved session config option reasoning_effort/,
        );
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
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
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loaded = true;
        return {};
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
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
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-connect-load-home-", run);
}
