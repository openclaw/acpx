import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeLiveRunState } from "../examples/flows/replay-viewer/server/live-run-state.js";
import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  SessionRecord,
  ViewerRunLiveState,
} from "../examples/flows/replay-viewer/src/types.js";

test("synthesizeLiveRunState replays bundled ACP events into a live current ACP attempt", () => {
  const sessionId = "main-bundle";
  const state = synthesizeLiveRunState(
    makeLiveBundle({
      sessionId,
      record: {
        schema: "acpx.session.v1",
        acpxRecordId: "session-record",
        acpSessionId: "agent-session",
        agentCommand: "codex",
        cwd: "/tmp/replay-live",
        createdAt: "2026-04-01T10:00:00.000Z",
        lastUsedAt: "2026-04-01T10:00:00.000Z",
        lastSeq: 0,
        eventLog: {
          active_path: "sessions/main-bundle/events.ndjson",
          segment_count: 1,
          max_segment_bytes: 67_108_864,
          max_segments: 1,
        },
        messages: [],
        updated_at: "2026-04-01T10:00:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      },
      events: [makePromptEvent(sessionId, 1, "hello"), makeChunkEvent(sessionId, 2, "hel")],
    }),
  );

  const liveStep = state.steps.at(-1);
  const session = state.sessions[sessionId];

  assert.ok(liveStep);
  assert.ok(session);
  assert.ok(Array.isArray(session?.record.messages));
  assert.equal(liveStep?.attemptId, "extract_intent#1");
  assert.equal(liveStep?.nodeId, "extract_intent");
  assert.equal(liveStep?.trace?.sessionId, sessionId);
  assert.equal(liveStep?.trace?.conversation?.eventStartSeq, 1);
  assert.equal(liveStep?.trace?.conversation?.eventEndSeq, 2);
  assert.equal(liveStep?.promptText, "hello");
  assert.equal(session?.record.lastSeq, 2);
  assert.equal(session?.record.messages?.length, 2);

  const user = session?.record.messages?.[0] as { User?: { content?: Array<{ Text?: string }> } };
  const agent = session?.record.messages?.[1] as {
    Agent?: { content?: Array<{ Text?: string }> };
  };
  assert.equal(user.User?.content?.[0]?.Text, "hello");
  assert.equal(agent.Agent?.content?.[0]?.Text, "hel");
});

test("synthesizeLiveRunState replays only new session events beyond record.lastSeq", () => {
  const sessionId = "main-bundle";
  const state = synthesizeLiveRunState(
    makeLiveBundle({
      sessionId,
      record: {
        schema: "acpx.session.v1",
        acpxRecordId: "session-record",
        acpSessionId: "agent-session",
        agentCommand: "codex",
        cwd: "/tmp/replay-live",
        createdAt: "2026-04-01T10:00:00.000Z",
        lastUsedAt: "2026-04-01T10:00:01.000Z",
        lastSeq: 2,
        eventLog: {
          active_path: "sessions/main-bundle/events.ndjson",
          segment_count: 1,
          max_segment_bytes: 67_108_864,
          max_segments: 1,
        },
        messages: [
          {
            User: {
              id: "user-1",
              content: [{ Text: "hello" }],
            },
          },
          {
            Agent: {
              content: [{ Text: "hel" }],
              tool_results: {},
            },
          },
        ],
        updated_at: "2026-04-01T10:00:01.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      },
      events: [
        makePromptEvent(sessionId, 1, "hello"),
        makeChunkEvent(sessionId, 2, "hel"),
        makeChunkEvent(sessionId, 3, "lo"),
      ],
    }),
  );

  const session = state.sessions[sessionId];
  const liveStep = state.steps.at(-1);
  assert.ok(session);
  assert.ok(liveStep);
  assert.ok(Array.isArray(session?.record.messages));
  const agent = session?.record.messages?.[1] as {
    Agent?: { content?: Array<{ Text?: string }> };
  };

  assert.equal(liveStep?.promptText, "hello");
  assert.equal(liveStep?.trace?.conversation?.messageStart, 0);
  assert.equal(liveStep?.trace?.conversation?.messageEnd, 1);
  assert.equal(liveStep?.trace?.conversation?.eventStartSeq, 1);
  assert.equal(liveStep?.trace?.conversation?.eventEndSeq, 3);
  assert.equal(agent.Agent?.content?.[0]?.Text, "hello");
  assert.equal(session?.record.lastSeq, 3);
});

function makeLiveBundle(options: {
  sessionId: string;
  record: SessionRecord;
  events: FlowBundledSessionEvent[];
}): ViewerRunLiveState {
  const binding: FlowSessionBinding = {
    key: "codex::/tmp/replay-live::main",
    handle: "main",
    bundleId: options.sessionId,
    name: "main",
    agentName: "codex",
    agentCommand: "codex",
    cwd: "/tmp/replay-live",
    acpxRecordId: options.record.acpxRecordId ?? "session-record",
    acpSessionId: options.record.acpSessionId ?? "agent-session",
  };

  const run: FlowRunState = {
    runId: "run-live",
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    startedAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-01T10:00:02.000Z",
    status: "running",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    sessionBindings: {
      [binding.key]: binding,
    },
    currentNode: "extract_intent",
    currentAttemptId: "extract_intent#1",
    currentNodeType: "acp",
    currentNodeStartedAt: "2026-04-01T10:00:00.000Z",
  };

  return {
    schema: "acpx.viewer-run-live.v1",
    sourceType: "recent",
    sourceLabel: "PR-triage-acpx-155",
    manifest: {
      schema: "acpx.flow-run-bundle.v1",
      runId: run.runId,
      flowName: run.flowName,
      runTitle: run.runTitle,
      startedAt: run.startedAt,
      status: run.status,
      traceSchema: "acpx.flow-trace-event.v1",
      paths: {
        flow: "flow.json",
        trace: "trace.ndjson",
        runProjection: "projections/run.json",
        liveProjection: "projections/live.json",
        stepsProjection: "projections/steps.json",
        sessionsDir: "sessions",
        artifactsDir: "artifacts",
      },
      sessions: [
        {
          id: options.sessionId,
          handle: "main",
          bindingPath: `sessions/${options.sessionId}/binding.json`,
          recordPath: `sessions/${options.sessionId}/record.json`,
          eventsPath: `sessions/${options.sessionId}/events.ndjson`,
        },
      ],
    } satisfies FlowRunManifest,
    flow: makeFlow(),
    run,
    live: {
      currentNode: run.currentNode,
      currentAttemptId: run.currentAttemptId,
      currentNodeType: run.currentNodeType,
      currentNodeStartedAt: run.currentNodeStartedAt,
      updatedAt: run.updatedAt,
      status: run.status,
    },
    steps: [],
    trace: [
      {
        seq: 1,
        at: "2026-04-01T10:00:00.000Z",
        scope: "acp",
        type: "acp_prompt_prepared",
        runId: run.runId,
        nodeId: run.currentNode,
        attemptId: run.currentAttemptId,
        sessionId: options.sessionId,
        payload: {
          sessionId: options.sessionId,
        },
      },
    ],
    sessions: {
      [options.sessionId]: {
        id: options.sessionId,
        binding,
        record: options.record,
        events: options.events,
      },
    },
  };
}

function makeFlow(): FlowDefinitionSnapshot {
  return {
    schema: "acpx.flow-definition-snapshot.v1",
    name: "pr-triage",
    startAt: "extract_intent",
    nodes: {
      extract_intent: { nodeType: "acp", session: { handle: "main", isolated: false } },
    },
    edges: [],
  };
}

function makePromptEvent(sessionId: string, seq: number, text: string): FlowBundledSessionEvent {
  return {
    seq,
    at: `2026-04-01T10:00:0${seq}.000Z`,
    direction: "outbound",
    message: {
      jsonrpc: "2.0",
      id: seq,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text }],
      },
    },
  };
}

function makeChunkEvent(sessionId: string, seq: number, text: string): FlowBundledSessionEvent {
  return {
    seq,
    at: `2026-04-01T10:00:0${seq}.000Z`,
    direction: "inbound",
    message: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    },
  };
}
