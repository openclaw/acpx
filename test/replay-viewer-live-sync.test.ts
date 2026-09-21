import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import {
  createFilesystemRunSource,
  type ViewerRunSource,
} from "../examples/flows/replay-viewer/server/live-source.js";
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
import { writePrivateJsonFile } from "../src/state-files.js";

test("replay viewer rejects malformed messages and isolates invalid frames", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-admission-"));
  const viewer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    livePollIntervalMs: 50,
  });
  const socket = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
  const inbox = createMessageInbox(socket);
  let invalidSocket: WebSocket | undefined;
  try {
    await onceOpen(socket);
    for (const payload of [
      "null",
      "{",
      JSON.stringify({ type: "subscribe_run", runId: 7 }),
      JSON.stringify({ type: "resync_run" }),
    ]) {
      socket.send(payload);
      const error = await inbox.next((message) => message.type === "error");
      assert.equal(error.code, "protocol_error");
    }
    socket.send(JSON.stringify({ type: "hello", protocol: "unsupported" }));
    assert.equal(
      (await inbox.next((message) => message.type === "error")).message,
      "Unsupported replay protocol.",
    );
    socket.send(Buffer.from(JSON.stringify({ type: "ping" })));
    await inbox.next((message) => message.type === "pong");

    invalidSocket = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
    await onceOpen(invalidSocket);
    const closed = once(invalidSocket, "close");
    invalidSocket.send(Buffer.from([0xff]), { binary: false });
    await closed;
    socket.send(JSON.stringify({ type: "ping" }));
    await inbox.next((message) => message.type === "pong");
    socket.send(JSON.stringify({ type: "subscribe_runs" }));
    assert.deepEqual(
      (await inbox.next((message) => message.type === "runs_snapshot")).state.order,
      [],
    );
  } finally {
    invalidSocket?.terminate();
    await closeSocket(socket);
    await viewer.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

for (const { resource, overlap } of [
  { resource: "runs", overlap: false },
  { resource: "run", overlap: false },
  { resource: "runs", overlap: true },
  { resource: "run", overlap: true },
] as const) {
  test(`replay viewer publishes ${resource} refreshes to existing subscribers${overlap ? " during polling" : ""}`, async () => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-refresh-"));
    const runId = "shared-run";
    await writeRunBundle(runsDir, {
      runId,
      flowName: "shared-flow",
      runTitle: "Shared subscriber proof",
      startedAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      projectedStatus: "running",
      liveStatus: "running",
      currentNode: "extract_intent",
      steps: [],
    });
    const filesystem = createFilesystemRunSource(runsDir);
    const runs = await filesystem.getRunsState();
    const run = await filesystem.getRunState(runId);
    let holdNextRead = false;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reportRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reportRead = resolve;
    });
    const beforeRead = async () => {
      if (holdNextRead) {
        holdNextRead = false;
        reportRead();
        await readGate;
      }
    };
    const viewer = await createReplayViewerServer({
      host: "127.0.0.1",
      port: 0,
      runsDir,
      livePollIntervalMs: overlap ? 50 : 60_000,
      source: {
        getRunsState: async () => {
          await beforeRead();
          return structuredClone(runs);
        },
        getRunState: async () => {
          await beforeRead();
          return structuredClone(run);
        },
      },
    });
    const first = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const second = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
    const firstInbox = createMessageInbox(first);
    const secondInbox = createMessageInbox(second);
    const subscription =
      resource === "runs" ? { type: "subscribe_runs" } : { type: "subscribe_run", runId };
    try {
      await Promise.all([onceOpen(first), onceOpen(second)]);
      first.send(JSON.stringify(subscription));
      const initial = await firstInbox.next(
        (message) => message.type === "runs_snapshot" || message.type === "run_snapshot",
      );
      if (overlap) {
        holdNextRead = true;
        await readStarted;
      }
      runs.runsById[runId].status = "completed";
      run.run.status = "completed";
      second.send(JSON.stringify(subscription));
      if (overlap) {
        second.send(JSON.stringify({ type: "ping" }));
        await secondInbox.next((message) => message.type === "pong");
        releaseRead();
      }
      const current = await secondInbox.next(
        (message) =>
          message.type === "runs_snapshot" ||
          message.type === "run_snapshot" ||
          message.type === "runs_patch" ||
          message.type === "run_patch",
      );
      assert(
        current.type === "runs_snapshot" || current.type === "run_snapshot",
        "new subscribers need a snapshot before patches",
      );
      first.send(JSON.stringify({ type: "ping" }));
      const update = await firstInbox.next(
        (message) =>
          message.type === "runs_patch" || message.type === "run_patch" || message.type === "pong",
      );
      assert.notEqual(
        update.type,
        "pong",
        "a peer snapshot must not consume an unpublished version",
      );
      assert(update.type === "runs_patch" || update.type === "run_patch");
      assert.equal(update.fromVersion, initial.version);
      assert.equal(update.toVersion, current.version);
      assert.deepEqual(applyReplayPatch(initial.state, update.ops), current.state);
    } finally {
      releaseRead();
      await Promise.all([closeSocket(first), closeSocket(second)]);
      await viewer.close();
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  });
}

test("replay viewer recovers a subscription whose initial read failed", async () => {
  let fail = true;
  const viewer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir: "/synthetic/replay",
    livePollIntervalMs: 60_000,
    source: {
      getRunsState: async () => {
        if (fail) {
          fail = false;
          throw new Error("transient read failure");
        }
        return buildViewerRunsState([]);
      },
      getRunState: async () => {
        throw new Error("unexpected selected run read");
      },
    },
  });
  const socket = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
  const inbox = createMessageInbox(socket);
  try {
    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "subscribe_runs" }));
    assert.equal((await inbox.next((message) => message.type === "error")).code, "internal_error");
    socket.send(JSON.stringify({ type: "ping" }));
    const recovered = await inbox.next(
      (message) => message.type === "runs_snapshot" || message.type === "pong",
    );
    assert.equal(recovered.type, "runs_snapshot", "recovery must establish the missing snapshot");
  } finally {
    await closeSocket(socket);
    await viewer.close();
  }
});

test("replay viewer discards refresh work from a disconnected requester", async () => {
  let reads = 0;
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const viewer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir: "/synthetic/replay",
    livePollIntervalMs: 60_000,
    source: {
      getRunsState: async () => {
        reads += 1;
        if (hold) {
          hold = false;
          started();
          await gate;
        }
        return buildViewerRunsState([]);
      },
      getRunState: async () => {
        throw new Error("unexpected selected run read");
      },
    },
  });
  const first = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
  const requester = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
  const firstInbox = createMessageInbox(first);
  const requesterInbox = createMessageInbox(requester);
  try {
    await Promise.all([onceOpen(first), onceOpen(requester)]);
    first.send(JSON.stringify({ type: "subscribe_runs" }));
    await firstInbox.next((message) => message.type === "runs_snapshot");
    hold = true;
    requester.send(JSON.stringify({ type: "subscribe_runs" }));
    await reading;
    const beforeBurst = reads;
    for (let index = 0; index < 25; index++) {
      requester.send(JSON.stringify({ type: "resync_runs" }));
    }
    requester.send(JSON.stringify({ type: "ping" }));
    await requesterInbox.next((message) => message.type === "pong");
    await closeSocket(requester);
    release();
    first.send(JSON.stringify({ type: "ping" }));
    await firstInbox.next((message) => message.type === "pong");
    assert.equal(reads, beforeBurst, "disconnected requests must not leave a read backlog");
  } finally {
    release();
    await Promise.all([closeSocket(first), closeSocket(requester)]);
    await viewer.close();
  }
});

test("replay viewer reports polling failures and resumes live run updates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-poll-error-"));
  const runsDir = path.join(directory, "runs");
  const savedRunsDir = path.join(directory, "saved-runs");
  await fs.mkdir(runsDir);
  const viewer = await createReplayViewerServer({
    host: "127.0.0.1",
    port: 0,
    runsDir,
    livePollIntervalMs: 50,
  });
  const socket = new WebSocket(viewer.baseUrl.replace(/^http/, "ws") + "/api/live");
  const inbox = createMessageInbox(socket);
  try {
    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "subscribe_runs" }));
    const initial = await inbox.next((message) => message.type === "runs_snapshot");
    await fs.rename(runsDir, savedRunsDir);
    await fs.writeFile(runsDir, "not a directory");
    assert.equal((await inbox.next((message) => message.type === "error")).code, "internal_error");
    await fs.rm(runsDir);
    await fs.rename(savedRunsDir, runsDir);
    await writeRunBundle(runsDir, {
      runId: "recovered",
      flowName: "synthetic",
      runTitle: "Recovered synthetic run",
      startedAt: "2026-09-15T00:00:00.000Z",
      projectedStatus: "running",
      liveStatus: "running",
      updatedAt: "2026-09-15T00:00:00.000Z",
      currentNode: "first",
      steps: [],
    });
    const update = await inbox.next((message) => message.type === "runs_patch");
    assert.equal(
      applyReplayPatch<ViewerRunsState>(initial.state, update.ops).runsById.recovered?.status,
      "running",
    );
  } finally {
    await closeSocket(socket);
    await viewer.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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

    let nextRunsState = runsSnapshot.state;
    let version = runsSnapshot.version;
    const deadline = Date.now() + 5_000;
    do {
      const remainingMs = deadline - Date.now();
      assert.ok(remainingMs > 0, "Timed out waiting for the live run update");
      const runsPatch = await inbox.next(
        (message): message is Extract<ReplayServerMessage, { type: "runs_patch" }> =>
          message.type === "runs_patch",
        remainingMs,
      );
      assert.equal(runsPatch.fromVersion, version);
      assert.equal(runsPatch.toVersion, version + 1);
      nextRunsState = applyReplayPatch<ViewerRunsState>(nextRunsState, runsPatch.ops);
      version = runsPatch.toVersion;
    } while (
      nextRunsState.runsById[runId]?.status !== "waiting" ||
      nextRunsState.runsById[runId]?.currentNode !== "judge_solution" ||
      nextRunsState.runsById[runId]?.updatedAt !== "2026-03-31T08:00:10.000Z"
    );

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

    let nextRunState = runSnapshot.state;
    let runPatch: Extract<ReplayServerMessage, { type: "run_patch" }>;
    const textPath = "/sessions/main-bundle/record/messages/1/Agent/content/0/Text";
    const patchDeadline = Date.now() + 5_000;
    do {
      const remainingMs = patchDeadline - Date.now();
      assert.ok(remainingMs > 0, "Timed out waiting for the streamed text patch");
      runPatch = await inbox.next(
        (message): message is Extract<ReplayServerMessage, { type: "run_patch" }> =>
          message.type === "run_patch" && message.runId === runId,
        remainingMs,
      );
      nextRunState = applyReplayPatch<ViewerRunLiveState>(nextRunState, runPatch.ops);
    } while (!runPatch.ops.some((op) => op.path.endsWith(textPath)));

    assert.equal(
      runPatch.ops.some(
        (op) => op.op === "append" && op.path.endsWith(textPath) && op.value === "lo",
      ),
      true,
    );

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

for (const sourceType of ["prompt", "user_message_chunk"] as const) {
  test(`replay projection keeps ${sourceType} identities stable across reads and checkpoints`, async (t) => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-replay-identities-"));
    t.after(() => fs.rm(runsDir, { recursive: true, force: true }));
    const runId = "stable-identities";
    const sessionId = "main-bundle";
    await writeLiveSessionRunBundle(runsDir, {
      runId,
      sessionId,
      promptText: "hello",
      initialAgentText: "hel",
    });
    const sessionDir = path.join(runsDir, runId, "sessions", sessionId);
    if (sourceType === "user_message_chunk") {
      const eventsFile = path.join(sessionDir, "events.ndjson");
      const events = (await fs.readFile(eventsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FlowBundledSessionEvent);
      events[0].message = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      };
      await fs.writeFile(
        eventsFile,
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
    }

    const source = createFilesystemRunSource(runsDir);
    const first = await source.getRunState(runId);
    assert.deepEqual(await source.getRunState(runId), first);

    await appendLiveSessionChunk(runsDir, runId, sessionId, 3, "lo");
    const grown = await source.getRunState(runId);
    assert.deepEqual(await source.getRunState(runId), grown);
    const firstUser = first.sessions[sessionId].record.messages?.[0];
    assert.deepEqual(grown.sessions[sessionId].record.messages?.[0], firstUser);

    const checkpoint = structuredClone(grown.sessions[sessionId].record);
    const checkpointUser = checkpoint.messages?.[0] as { User: { id: string } };
    checkpointUser.User.id = "persisted-user-id";
    await fs.writeFile(path.join(sessionDir, "record.json"), JSON.stringify(checkpoint));
    const restored = await source.getRunState(runId);
    assert.deepEqual(restored.sessions[sessionId].record.messages?.[0], checkpointUser);
    assert.deepEqual(await source.getRunState(runId), restored);
  });
}

function createMessageInbox(socket: WebSocket) {
  const backlog: ReplayServerMessage[] = [];
  const waiters: Array<{
    predicate(message: ReplayServerMessage): boolean;
    resolve(message: ReplayServerMessage): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(new Uint8Array(data)).toString("utf8");
    const message = JSON.parse(text) as ReplayServerMessage;

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
  source?: ViewerRunSource;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const liveSyncServer = createReplayLiveSyncServer({
    source: options.source ?? createFilesystemRunSource(options.runsDir),
    pollIntervalMs: options.livePollIntervalMs,
  });
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end("Not found");
  });

  server.on("upgrade", (request, socket, head) => {
    if (!liveSyncServer.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
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

  await writePrivateJsonFile(path.join(projectionsDir, "live.json"), {
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
  } satisfies Partial<FlowRunState>);
  await writePrivateJsonFile(path.join(projectionsDir, "steps.json"), options.steps);
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
