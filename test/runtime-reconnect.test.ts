import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SessionModelState } from "@agentclientprotocol/sdk";
import { connectAndLoadSession } from "../src/runtime/reconnect.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempDir } from "./runtime-test-helpers.js";

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
  ) => Promise<{ agentSessionId?: string; models?: SessionModelState }>;
  createSession: (cwd: string) => Promise<{
    sessionId: string;
    agentSessionId?: string;
    models?: SessionModelState;
  }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;
};

const ACTIVE_CONTROLLER = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionConfigOption: async () => {},
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

async function withWorkspaceRecord(
  name: string,
  build: (cwd: string) => SessionRecord,
  fn: (record: SessionRecord, cwd: string) => Promise<void>,
): Promise<void> {
  await withTempDir(`acpx-runtime-reconnect-${name}-`, async (dir) => {
    const cwd = path.join(dir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fn(build(cwd), cwd);
  });
}

test("connectAndLoadSession resumes an existing load-capable session", async () => {
  await withWorkspaceRecord(
    "resume",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "resume-record",
        acpSessionId: "resume-session",
        agentCommand: "agent",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:05:00.000Z",
      }),
    async (record, cwd) => {
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
    },
  );
});

test("connectAndLoadSession falls back to createSession when load returns resource-not-found", async () => {
  await withWorkspaceRecord(
    "fallback-not-found",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "fallback-record",
        acpSessionId: "old-session",
        agentCommand: "agent",
        cwd,
      }),
    async (record, cwd) => {
      const client: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
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
    },
  );
});

test("connectAndLoadSession respects same-session-only resume policy", async () => {
  await withWorkspaceRecord(
    "same-session-only",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "strict-resume-record",
        acpSessionId: "strict-resume-session",
        agentCommand: "agent",
        cwd,
      }),
    async (record) => {
      const client: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
        supportsLoadSession: () => true,
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
    },
  );
});

test("connectAndLoadSession falls back for empty sessions on ACP internal errors and unsupported load methods", async () => {
  await withWorkspaceRecord(
    "empty-and-unsupported",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "empty-record",
        acpSessionId: "empty-session",
        agentCommand: "agent",
        cwd,
        messages: [],
      }),
    async (record) => {
      const internalErrorClient: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
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
        setSessionModel: async () => {},
      };
      const internalResult = await connectAndLoadSession({
        client: internalErrorClient as never,
        record,
        activeController: ACTIVE_CONTROLLER,
      });
      assert.equal(internalResult.sessionId, "created-for-empty");
      assert.equal(internalResult.resumed, false);

      const unsupportedLoadRecord = makeSessionRecord({
        acpxRecordId: "unsupported-load-record",
        acpSessionId: "unsupported-load-session",
        agentCommand: "agent",
        cwd: record.cwd,
      });
      const unsupportedLoadClient: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
        supportsLoadSession: () => false,
        loadSessionWithOptions: async () => {
          throw new Error("loadSession should not be called");
        },
        createSession: async () => ({
          sessionId: "created-without-load",
          agentSessionId: "fresh-runtime",
        }),
        setSessionMode: async () => {},
        setSessionModel: async () => {},
      };
      const unsupportedLoadResult = await connectAndLoadSession({
        client: unsupportedLoadClient as never,
        record: unsupportedLoadRecord,
        activeController: ACTIVE_CONTROLLER,
      });
      assert.equal(unsupportedLoadResult.sessionId, "created-without-load");
      assert.equal(unsupportedLoadResult.resumed, false);
    },
  );
});

test("connectAndLoadSession rethrows load failures that should not create a new session", async () => {
  await withWorkspaceRecord(
    "rethrow",
    (cwd) =>
      makeSessionRecord({
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
      }),
    async (record) => {
      const client: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
        supportsLoadSession: () => true,
        loadSessionWithOptions: async () => {
          throw {
            error: {
              code: -32603,
              message: "still broken",
            },
          };
        },
        createSession: async () => ({ sessionId: "unexpected" }),
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
    },
  );
});

test("connectAndLoadSession replays desired mode and model on fresh sessions", async () => {
  await withWorkspaceRecord(
    "replay",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "replay-record",
        acpSessionId: "stale-session",
        agentCommand: "agent",
        cwd,
        acpx: {
          desired_mode_id: "plan",
          session_options: {
            model: "gpt-5.4",
          },
        },
      }),
    async (record) => {
      let setModeCalls = 0;
      let setModelCalls = 0;
      const client: FakeClient = {
        hasReusableSession: () => false,
        start: async () => {},
        getAgentLifecycleSnapshot: () => ({ running: true }),
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
          models: buildModelsState("default-model"),
        }),
        setSessionMode: async (sessionId, modeId) => {
          setModeCalls += 1;
          assert.equal(sessionId, "fresh-session");
          assert.equal(modeId, "plan");
        },
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
      assert.equal(setModeCalls, 1);
      assert.equal(setModelCalls, 1);
      assert.equal(record.acpSessionId, "fresh-session");
      assert.equal(record.acpx?.current_model_id, "gpt-5.4");
      assert.deepEqual(record.acpx?.available_models, ["default-model", "gpt-5.4"]);
    },
  );
});

test("connectAndLoadSession reuses already loaded client sessions", async () => {
  await withWorkspaceRecord(
    "reused",
    (cwd) =>
      makeSessionRecord({
        acpxRecordId: "reused-record",
        acpSessionId: "reused-session",
        agentCommand: "agent",
        cwd,
      }),
    async (record) => {
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
    },
  );
});
