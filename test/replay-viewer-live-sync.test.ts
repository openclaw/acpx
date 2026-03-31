import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createReplayViewerServer } from "../examples/flows/replay-viewer/server/viewer-server.js";
import { applyReplayPatch } from "../examples/flows/replay-viewer/src/lib/live-sync.js";
import type {
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowStepRecord,
  ReplayServerMessage,
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
    disableDependencyOptimization: true,
  });

  try {
    const socket = new WebSocket(viewerServer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const inbox = createMessageInbox(socket);

    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: "acpx.replay.v1" }));
    socket.send(JSON.stringify({ type: "subscribe_runs" }));
    socket.send(JSON.stringify({ type: "subscribe_run", runId }));

    await inbox.next((message) => message.type === "ready");
    const runsSnapshot = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "runs_snapshot" }> =>
        message.type === "runs_snapshot",
    );
    const runSnapshot = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "run_snapshot" }> =>
        message.type === "run_snapshot" && message.runId === runId,
    );

    assert.equal(runsSnapshot.state.runs[0]?.status, "running");
    assert.equal(runsSnapshot.state.runs[0]?.runTitle, "PR-triage-acpx-155");
    assert.equal(runSnapshot.state.run.status, "running");
    assert.equal(runSnapshot.state.run.currentNode, "extract_intent");
    assert.equal(runSnapshot.state.steps.length, 1);

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
    const runPatch = await inbox.next(
      (message): message is Extract<ReplayServerMessage, { type: "run_patch" }> =>
        message.type === "run_patch" && message.runId === runId,
    );

    const nextRunsState = applyReplayPatch<ViewerRunsState>(runsSnapshot.state, runsPatch.ops);
    const nextRunState = applyReplayPatch<ViewerRunLiveState>(runSnapshot.state, runPatch.ops);

    assert.equal(nextRunsState.runs[0]?.status, "waiting");
    assert.equal(nextRunsState.runs[0]?.currentNode, "judge_solution");
    assert.equal(nextRunState.run.status, "waiting");
    assert.equal(nextRunState.run.currentNode, "judge_solution");
    assert.equal(nextRunState.steps.length, 2);

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
      timeoutMs: number = 5_000,
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
