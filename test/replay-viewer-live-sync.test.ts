import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createFilesystemRunSource } from "../examples/flows/replay-viewer/server/live-source.js";
import {
  computeResourceDelta,
  createReplayLiveSyncServer,
} from "../examples/flows/replay-viewer/server/live-sync.js";
import { applyReplayPatch } from "../examples/flows/replay-viewer/src/lib/live-sync.js";
import {
  buildViewerRunsState,
  listViewerRuns,
} from "../examples/flows/replay-viewer/src/lib/runs-state.js";
import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  ReplayServerMessage,
  SessionRecord,
  ViewerRunLiveState,
  ViewerRunsState,
} from "../examples/flows/replay-viewer/src/types.js";

test("replay viewer streams live sidebar and run patches over websocket", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-live-"));
  const runId = "2026-03-31T080000000Z-pr-triage-live";
  const startedAt = "2026-03-31T08:00:00.000Z";
  const firstStep = makeStep(
    "extract_intent#1",
    "extract_intent",
    startedAt,
    "2026-03-31T08:00:04.000Z",
  );
  await writeRunBundle(runsDir, {
    runId,
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    startedAt,
    projectedStatus: "completed",
    liveStatus: "running",
    updatedAt: "2026-03-31T08:00:05.000Z",
    currentNode: "extract_intent",
    steps: [firstStep],
  });

  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    livePollIntervalMs: 50,
  });

  try {
    const socket = new WebSocket(viewerServer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const inbox = createMessageInbox(socket);

    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
    socket.send(JSON.stringify({ type: "subscribe_runs" }));

    await inbox.next((message) => message.type === "ready");
    const runsSnapshot = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "runs_snapshot" }> =>
        message.type === "runs_snapshot",
    );

    assert.equal(listViewerRuns(runsSnapshot.state)[0]?.status, "running");
    assert.equal(listViewerRuns(runsSnapshot.state)[0]?.runTitle, "PR-triage-acpx-155");

    const secondStep = makeStep(
      "judge_solution#1",
      "judge_solution",
      "2026-03-31T08:00:06.000Z",
      "2026-03-31T08:00:09.000Z",
    );
    await updateRunBundle(runsDir, runId, {
      liveStatus: "waiting",
      updatedAt: "2026-03-31T08:00:10.000Z",
      currentNode: "judge_solution",
      steps: [firstStep, secondStep],
    });

    const runsPatch = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "runs_patch" }> =>
        message.type === "runs_patch",
    );

    const nextRunsState = applyReplayPatch<ViewerRunsState>(runsSnapshot.state, runsPatch.ops);

    assert.equal(listViewerRuns(nextRunsState)[0]?.status, "waiting");
    assert.equal(listViewerRuns(nextRunsState)[0]?.currentNode, "judge_solution");

    socket.close();
  } finally {
    await viewerServer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("computeResourceDelta falls back to a snapshot when patch generation throws", () => {
  const nextRun = {
    runId: "2026-04-01T180000000Z-example-two-turn-live",
    flowName: "example-two-turn",
    status: "running" as const,
    startedAt: "2026-04-01T18:00:00.000Z",
    updatedAt: "2026-04-01T18:00:01.000Z",
    path: "/tmp/acpx-live-run",
  };
  const previousState: ViewerRunsState = buildViewerRunsState([]);
  const nextState: ViewerRunsState = buildViewerRunsState([nextRun]);

  const delta = computeResourceDelta(previousState, nextState, () => {
    throw new Error("patch exploded");
  });

  assert.deepEqual(delta, {
    kind: "snapshot",
    state: nextState,
  });
});

test("computeResourceDelta produces a stable patch when recent runs reorder", () => {
  const firstRun = {
    runId: "2026-04-01T180100000Z-example-two-turn-a",
    flowName: "example-two-turn",
    status: "completed" as const,
    startedAt: "2026-04-01T18:01:00.000Z",
    updatedAt: "2026-04-01T18:01:05.000Z",
    path: "/tmp/acpx-live-run-a",
  };
  const secondRun = {
    runId: "2026-04-01T180200000Z-example-two-turn-b",
    flowName: "example-two-turn",
    status: "running" as const,
    startedAt: "2026-04-01T18:02:00.000Z",
    updatedAt: "2026-04-01T18:02:01.000Z",
    currentNode: "inspect_workspace",
    path: "/tmp/acpx-live-run-b",
  };
  const previousState = buildViewerRunsState([firstRun, secondRun]);
  const nextState = buildViewerRunsState([
    {
      ...secondRun,
      updatedAt: "2026-04-01T18:02:02.000Z",
      currentNode: "draft",
    },
    firstRun,
  ]);

  const delta = computeResourceDelta(previousState, nextState);

  assert.equal(delta.kind, "patch");
  assert.deepEqual(applyReplayPatch(previousState, delta.ops), nextState);
});

test("replay viewer refreshes runs snapshots after idle periods", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-live-runs-refresh-"));
  const firstRunId = "2026-03-31T080000000Z-pr-triage-live-a";
  const secondRunId = "2026-03-31T080100000Z-pr-triage-live-b";
  const firstStep = makeStep(
    "extract_intent#1",
    "extract_intent",
    "2026-03-31T08:00:00.000Z",
    "2026-03-31T08:00:04.000Z",
  );

  await writeRunBundle(runsDir, {
    runId: firstRunId,
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    startedAt: "2026-03-31T08:00:00.000Z",
    projectedStatus: "completed",
    liveStatus: "running",
    updatedAt: "2026-03-31T08:00:05.000Z",
    currentNode: "extract_intent",
    steps: [firstStep],
  });

  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    livePollIntervalMs: 50,
  });

  try {
    const firstSocket = new WebSocket(viewerServer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const firstInbox = createMessageInbox(firstSocket);

    await onceOpen(firstSocket);
    firstSocket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
    firstSocket.send(JSON.stringify({ type: "subscribe_runs" }));
    await firstInbox.next((message) => message.type === "ready");

    const firstSnapshot = await firstInbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "runs_snapshot" }> =>
        message.type === "runs_snapshot",
    );
    assert.equal(listViewerRuns(firstSnapshot.state)[0]?.runId, firstRunId);

    await closeSocket(firstSocket);

    const secondStep = makeStep(
      "judge_solution#1",
      "judge_solution",
      "2026-03-31T08:01:00.000Z",
      "2026-03-31T08:01:03.000Z",
    );
    await writeRunBundle(runsDir, {
      runId: secondRunId,
      flowName: "pr-triage",
      runTitle: "PR-triage-acpx-156",
      startedAt: "2026-03-31T08:01:00.000Z",
      projectedStatus: "completed",
      liveStatus: "running",
      updatedAt: "2026-03-31T08:01:04.000Z",
      currentNode: "judge_solution",
      steps: [secondStep],
    });

    const secondSocket = new WebSocket(viewerServer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const secondInbox = createMessageInbox(secondSocket);

    await onceOpen(secondSocket);
    secondSocket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
    secondSocket.send(JSON.stringify({ type: "subscribe_runs" }));
    await secondInbox.next((message) => message.type === "ready");

    const secondSnapshot = await secondInbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "runs_snapshot" }> =>
        message.type === "runs_snapshot",
    );
    assert.equal(listViewerRuns(secondSnapshot.state)[0]?.runId, secondRunId);
    assert.equal(listViewerRuns(secondSnapshot.state)[1]?.runId, firstRunId);

    await closeSocket(secondSocket);
  } finally {
    await viewerServer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("replay viewer streams selected-run ACP text as JSON Patch+ append updates", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-live-session-"));
  const runId = "2026-04-01T080000000Z-pr-triage-live-session";
  const sessionId = "main-bundle";
  await writeLiveSessionRunBundle(runsDir, {
    runId,
    sessionId,
    promptText: "hello",
    initialAgentText: "hel",
  });

  const viewerServer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    livePollIntervalMs: 25,
  });

  try {
    const socket = new WebSocket(viewerServer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const inbox = createMessageInbox(socket);

    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
    socket.send(JSON.stringify({ type: "subscribe_run", runId }));

    await inbox.next((message) => message.type === "ready");
    const runSnapshot = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "run_snapshot" }> =>
        message.type === "run_snapshot" && message.runId === runId,
    );

    const syntheticLiveStep = runSnapshot.state.steps.at(-1);
    const initialSession = runSnapshot.state.sessions[sessionId];
    assert.ok(initialSession);
    assert.ok(Array.isArray(initialSession?.record.messages));
    const initialMessages = initialSession.record.messages as Array<{
      Agent?: { content?: Array<{ Text?: string }> };
    }>;
    assert.equal(syntheticLiveStep?.attemptId, "extract_intent#1");
    assert.equal(syntheticLiveStep?.promptText, "hello");
    assert.equal(initialMessages[1]?.Agent?.content?.[0]?.Text, "hel");

    await appendLiveSessionChunk(runsDir, runId, sessionId, 3, "lo");

    const runPatch = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "run_patch" }> =>
        message.type === "run_patch" && message.runId === runId,
    );

    assert.equal(
      runPatch.ops.some(
        (op) =>
          op.op === "append" &&
          op.path.endsWith("/sessions/main-bundle/record/messages/1/Agent/content/0/Text") &&
          op.value === "lo",
      ),
      true,
    );

    const nextRunState = applyReplayPatch<ViewerRunLiveState>(runSnapshot.state, runPatch.ops);
    const nextSession = nextRunState.sessions[sessionId];
    assert.ok(nextSession);
    assert.ok(Array.isArray(nextSession?.record.messages));
    const nextMessages = nextSession.record.messages as Array<{
      Agent?: { content?: Array<{ Text?: string }> };
    }>;
    assert.equal(nextMessages[1]?.Agent?.content?.[0]?.Text, "hello");

    socket.close();
  } finally {
    await viewerServer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

function createMessageInbox(socket: WebSocket) {
  const backlog: ReplayServerMessage[] = [];
  const waiters: Array<{
    predicate(message: ReplayServerMessage): boolean;
    resolve(message: ReplayServerMessage): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as ReplayServerMessage;

    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (!waiter || !waiter.predicate(message)) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }

    backlog.push(message);
  });

  return {
    async next<TMessage extends ReplayServerMessage>(
      predicate: (message: ReplayServerMessage) => message is TMessage,
      timeoutMs: number = 30_000,
    ): Promise<TMessage> {
      for (let index = 0; index < backlog.length; index += 1) {
        const message = backlog[index];
        if (!message || !predicate(message)) {
          continue;
        }
        backlog.splice(index, 1);
        return message;
      }

      return await new Promise<TMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for replay viewer message."));
        }, timeoutMs);
        waiters.push({
          predicate: (message): boolean => predicate(message),
          resolve: (message) => resolve(message as TMessage),
          reject,
          timer,
        });
      });
    },
  };
}

async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

async function createReplayViewerServer(options: {
  host: string;
  port: number;
  runsDir: string;
  livePollIntervalMs: number;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const liveSyncServer = createReplayLiveSyncServer({
    source: createFilesystemRunSource(options.runsDir),
    pollIntervalMs: options.livePollIntervalMs,
  });
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end("Not found");
  });

  server.on("upgrade", (request, socket, head) => {
    void liveSyncServer.handleUpgrade(request, socket, head).then((handled) => {
      if (!handled) {
        socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind replay live-sync test server.");
  }

  return {
    baseUrl: `http://${options.host}:${address.port}`,
    async close(): Promise<void> {
      await liveSyncServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function writeRunBundle(
  runsDir: string,
  options: {
    runId: string;
    flowName: string;
    runTitle: string;
    startedAt: string;
    projectedStatus: FlowRunState["status"];
    liveStatus: FlowRunState["status"];
    updatedAt: string;
    currentNode: string;
    steps: FlowStepRecord[];
  },
): Promise<void> {
  const runDir = path.join(runsDir, options.runId);
  const projectionsDir = path.join(runDir, "projections");
  await fs.mkdir(projectionsDir, { recursive: true });

  const flow = makeFlow();
  const manifest: FlowRunManifest = {
    schema: "acpx.flow-run-bundle.v1",
    runId: options.runId,
    flowName: options.flowName,
    runTitle: options.runTitle,
    startedAt: options.startedAt,
    status: options.liveStatus,
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
    sessions: [],
  };

  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(runDir, "flow.json"), JSON.stringify(flow));
  await fs.writeFile(path.join(runDir, "trace.ndjson"), "");
  await fs.mkdir(path.join(runDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(runDir, "artifacts"), { recursive: true });

  await fs.writeFile(
    path.join(projectionsDir, "run.json"),
    JSON.stringify({
      runId: options.runId,
      flowName: options.flowName,
      runTitle: options.runTitle,
      startedAt: options.startedAt,
      updatedAt: options.startedAt,
      status: options.projectedStatus,
      input: {},
      outputs: {},
      results: {},
      steps: options.steps,
      sessionBindings: {},
      currentNode: options.currentNode,
      currentAttemptId: options.steps.at(-1)?.attemptId,
      currentNodeType: options.steps.at(-1)?.nodeType,
      currentNodeStartedAt: options.steps.at(-1)?.startedAt,
    } satisfies FlowRunState),
  );

  await fs.writeFile(
    path.join(projectionsDir, "live.json"),
    JSON.stringify({
      runId: options.runId,
      flowName: options.flowName,
      runTitle: options.runTitle,
      startedAt: options.startedAt,
      updatedAt: options.updatedAt,
      status: options.liveStatus,
      currentNode: options.currentNode,
      currentAttemptId: options.steps.at(-1)?.attemptId,
      currentNodeType: options.steps.at(-1)?.nodeType,
      currentNodeStartedAt: options.steps.at(-1)?.startedAt,
    } satisfies Partial<FlowRunState>),
  );

  await fs.writeFile(path.join(projectionsDir, "steps.json"), JSON.stringify(options.steps));
}

async function updateRunBundle(
  runsDir: string,
  runId: string,
  options: {
    liveStatus: FlowRunState["status"];
    updatedAt: string;
    currentNode: string;
    steps: FlowStepRecord[];
  },
): Promise<void> {
  const runDir = path.join(runsDir, runId);
  const projectionsDir = path.join(runDir, "projections");
  const run = JSON.parse(
    await fs.readFile(path.join(projectionsDir, "run.json"), "utf8"),
  ) as FlowRunState;

  await fs.writeFile(
    path.join(projectionsDir, "live.json"),
    JSON.stringify({
      runId,
      flowName: run.flowName,
      runTitle: run.runTitle,
      startedAt: run.startedAt,
      updatedAt: options.updatedAt,
      status: options.liveStatus,
      currentNode: options.currentNode,
      currentAttemptId: options.steps.at(-1)?.attemptId,
      currentNodeType: options.steps.at(-1)?.nodeType,
      currentNodeStartedAt: options.steps.at(-1)?.startedAt,
    } satisfies Partial<FlowRunState>),
  );
  await fs.writeFile(path.join(projectionsDir, "steps.json"), JSON.stringify(options.steps));
}

function makeFlow(): FlowDefinitionSnapshot {
  return {
    schema: "acpx.flow-definition-snapshot.v1",
    name: "pr-triage",
    startAt: "extract_intent",
    nodes: {
      extract_intent: { nodeType: "acp", session: { handle: "main", isolated: false } },
      judge_solution: { nodeType: "acp", session: { handle: "main", isolated: false } },
    },
    edges: [{ from: "extract_intent", to: "judge_solution" }],
  };
}

function makeStep(
  attemptId: string,
  nodeId: string,
  startedAt: string,
  finishedAt: string,
): FlowStepRecord {
  return {
    attemptId,
    nodeId,
    nodeType: "acp",
    outcome: "ok",
    startedAt,
    finishedAt,
    promptText: `Prompt for ${nodeId}`,
    rawText: `Response for ${nodeId}`,
    output: {
      route: nodeId,
    },
    session: null,
    agent: {
      agentName: "codex",
      agentCommand: "codex",
      cwd: "/tmp/replay-live-sync",
    },
  };
}

async function writeLiveSessionRunBundle(
  runsDir: string,
  options: {
    runId: string;
    sessionId: string;
    promptText: string;
    initialAgentText: string;
  },
): Promise<void> {
  const runDir = path.join(runsDir, options.runId);
  const projectionsDir = path.join(runDir, "projections");
  const sessionDir = path.join(runDir, "sessions", options.sessionId);
  await fs.mkdir(projectionsDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(path.join(runDir, "artifacts"), { recursive: true });

  const binding: FlowSessionBinding = {
    key: "codex::/tmp/replay-live-sync::main",
    handle: "main",
    bundleId: options.sessionId,
    name: "main",
    agentName: "codex",
    agentCommand: "codex",
    cwd: "/tmp/replay-live-sync",
    acpxRecordId: "session-record",
    acpSessionId: "agent-session",
  };

  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: "session-record",
    acpSessionId: "agent-session",
    agentCommand: "codex",
    cwd: "/tmp/replay-live-sync",
    createdAt: "2026-04-01T08:00:00.000Z",
    lastUsedAt: "2026-04-01T08:00:00.000Z",
    lastSeq: 0,
    eventLog: {
      active_path: `sessions/${options.sessionId}/events.ndjson`,
      segment_count: 1,
      max_segment_bytes: 67_108_864,
      max_segments: 1,
    },
    messages: [],
    updated_at: "2026-04-01T08:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
  };

  const manifest: FlowRunManifest = {
    schema: "acpx.flow-run-bundle.v1",
    runId: options.runId,
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    startedAt: "2026-04-01T08:00:00.000Z",
    status: "running",
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
  };

  const run: FlowRunState = {
    runId: options.runId,
    flowName: "pr-triage",
    runTitle: "PR-triage-acpx-155",
    startedAt: "2026-04-01T08:00:00.000Z",
    updatedAt: "2026-04-01T08:00:00.000Z",
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
    currentNodeStartedAt: "2026-04-01T08:00:00.000Z",
  };

  const events: FlowBundledSessionEvent[] = [
    {
      seq: 1,
      at: "2026-04-01T08:00:01.000Z",
      direction: "outbound",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: {
          sessionId: "agent-session",
          prompt: [{ type: "text", text: options.promptText }],
        },
      },
    },
    {
      seq: 2,
      at: "2026-04-01T08:00:02.000Z",
      direction: "inbound",
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: options.initialAgentText },
          },
        },
      },
    },
  ];

  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(runDir, "flow.json"), JSON.stringify(makeFlow()));
  await fs.writeFile(
    path.join(runDir, "trace.ndjson"),
    `${JSON.stringify({
      seq: 1,
      at: "2026-04-01T08:00:00.500Z",
      scope: "acp",
      type: "acp_prompt_prepared",
      runId: options.runId,
      nodeId: "extract_intent",
      attemptId: "extract_intent#1",
      sessionId: options.sessionId,
      payload: {
        sessionId: options.sessionId,
      },
    })}\n`,
  );
  await fs.writeFile(path.join(projectionsDir, "run.json"), JSON.stringify(run));
  await fs.writeFile(
    path.join(projectionsDir, "live.json"),
    JSON.stringify({
      runId: run.runId,
      flowName: run.flowName,
      runTitle: run.runTitle,
      startedAt: run.startedAt,
      updatedAt: "2026-04-01T08:00:02.000Z",
      status: run.status,
      currentNode: run.currentNode,
      currentAttemptId: run.currentAttemptId,
      currentNodeType: run.currentNodeType,
      currentNodeStartedAt: run.currentNodeStartedAt,
      sessionBindings: run.sessionBindings,
    } satisfies Partial<FlowRunState>),
  );
  await fs.writeFile(path.join(projectionsDir, "steps.json"), JSON.stringify([]));
  await fs.writeFile(path.join(sessionDir, "binding.json"), JSON.stringify(binding));
  await fs.writeFile(path.join(sessionDir, "record.json"), JSON.stringify(record));
  await fs.writeFile(
    path.join(sessionDir, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

async function appendLiveSessionChunk(
  runsDir: string,
  runId: string,
  sessionId: string,
  seq: number,
  text: string,
): Promise<void> {
  const runDir = path.join(runsDir, runId);
  const projectionsDir = path.join(runDir, "projections");
  const sessionEventsPath = path.join(runDir, "sessions", sessionId, "events.ndjson");
  await fs.appendFile(
    sessionEventsPath,
    `${JSON.stringify({
      seq,
      at: `2026-04-01T08:00:0${seq}.000Z`,
      direction: "inbound",
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      },
    })}\n`,
  );

  const live = JSON.parse(
    await fs.readFile(path.join(projectionsDir, "live.json"), "utf8"),
  ) as Partial<FlowRunState>;
  live.updatedAt = `2026-04-01T08:00:0${seq}.000Z`;
  await fs.writeFile(path.join(projectionsDir, "live.json"), JSON.stringify(live));
}
