import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSyntheticSessionRecord } from "../src/flows/runtime-support.js";
import {
  defineFlow,
  acp,
  action,
  checkpoint,
  compute,
  shell,
  type FlowRunState,
} from "../src/flows/runtime.js";
import { FlowRunStore, flowRunsBaseDir } from "../src/flows/store.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SESSION_RECORD_SCHEMA, type SessionRecord } from "../src/types.js";

test("flowRunsBaseDir defaults under the acpx home directory", () => {
  assert.equal(flowRunsBaseDir("/tmp/home"), path.join("/tmp/home", ".acpx", "flows", "runs"));
});

test("FlowRunStore keeps private writes and cleans failed publication without changing outputRoot", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-private-"));
  const previousUmask = process.umask(0o002);
  t.after(async () => {
    process.umask(previousUmask);
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
  if (process.platform !== "win32") {
    await fs.chmod(outputRoot, 0o775);
  }
  const store = new FlowRunStore(outputRoot);
  const runDir = await store.createRunDir("private-run");
  const state: FlowRunState = {
    runId: "private-run",
    flowName: "private",
    status: "running",
    startedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    input: {},
    outputs: {},
    results: {},
    steps: [],
    sessionBindings: {},
  };
  const event = { scope: "run" as const, type: "heartbeat", payload: {} };
  await store.writeLive(runDir, state, event);
  const livePath = path.join(runDir, "projections", "live.json");
  if (process.platform !== "win32") {
    await fs.chmod(livePath, 0o664);
  }
  state.statusDetail = "next heartbeat";
  await store.writeLive(runDir, state, event);
  assert.equal(JSON.parse(await fs.readFile(livePath, "utf8")).statusDetail, "next heartbeat");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(livePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(runDir, "trace.ndjson"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(runDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o775);
  }
  await fs.unlink(livePath);
  await fs.mkdir(livePath);
  await assert.rejects(store.writeLive(runDir, state, event));
  assert.deepEqual(await fs.readdir(path.dirname(livePath)), ["live.json"]);
});

test("FlowRunStore writes manifest, projections, flow snapshot, and trace events", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-test-"));

  try {
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("run-123");
    const state: FlowRunState = {
      runId: "run-123",
      flowName: "demo",
      runTitle: "Demo run title",
      flowPath: "/tmp/demo.flow.ts",
      startedAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
      status: "running",
      input: { ok: true },
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
      currentNode: "prepare",
      currentAttemptId: "prepare#1",
      currentNodeType: "action",
      currentNodeStartedAt: "2026-03-26T00:00:01.000Z",
      lastHeartbeatAt: "2026-03-26T00:00:01.000Z",
      statusDetail: "Preparing",
    };
    const flow = defineFlow({
      name: "demo",
      run: {
        title: () => "Dynamic title",
      },
      permissions: {
        requiredMode: "approve-all",
        requireExplicitGrant: true,
        reason: "store test",
      },
      startAt: "prepare",
      nodes: {
        prepare: action({
          timeoutMs: 500,
          heartbeatMs: 50,
          statusDetail: "Preparing",
          run: () => ({ ok: true }),
        }),
        prompt: acp({
          profile: "mock",
          session: {
            handle: "review",
            isolated: true,
          },
          cwd: () => "/tmp/workspace",
          prompt: () => "echo ok",
          parse: (text) => text,
        }),
        shell_step: shell({
          exec: () => ({
            command: process.execPath,
            args: ["--version"],
          }),
          parse: (result) => result.stdout,
        }),
        compute_step: compute({
          run: () => ({ computed: true }),
        }),
        checkpoint_step: checkpoint({
          summary: "Review state",
          run: () => ({ approved: true }),
        }),
      },
      edges: [],
    });

    await store.initializeRunBundle(runDir, {
      flow,
      state,
    });

    const manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8")) as {
      schema: string;
      runTitle?: string;
      paths: {
        runProjection: string;
        liveProjection: string;
        stepsProjection: string;
        trace: string;
      };
    };
    const flowSnapshot = JSON.parse(await fs.readFile(path.join(runDir, "flow.json"), "utf8")) as {
      schema: string;
      run?: { hasTitle?: boolean };
      permissions?: {
        requiredMode?: string;
        requireExplicitGrant?: boolean;
        reason?: string;
      };
      nodes: Record<
        string,
        {
          nodeType: string;
          timeoutMs?: number;
          heartbeatMs?: number;
          statusDetail?: string;
          actionExecution?: string;
          hasExec?: boolean;
          hasParse?: boolean;
          hasPrompt?: boolean;
          cwd?: {
            mode: string;
          };
          session?: {
            handle?: string;
            isolated?: boolean;
          };
          summary?: string;
          hasRun?: boolean;
        }
      >;
    };
    const snapshot = JSON.parse(
      await fs.readFile(path.join(runDir, "projections", "run.json"), "utf8"),
    ) as {
      runId: string;
      runTitle?: string;
      currentNode?: string;
      statusDetail?: string;
    };
    const live = JSON.parse(
      await fs.readFile(path.join(runDir, "projections", "live.json"), "utf8"),
    ) as {
      runId: string;
      runTitle?: string;
      currentNode?: string;
      currentAttemptId?: string;
      statusDetail?: string;
    };
    const steps = JSON.parse(
      await fs.readFile(path.join(runDir, "projections", "steps.json"), "utf8"),
    ) as unknown[];
    const events = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; at?: string; seq?: number });

    assert.equal(manifest.schema, "acpx.flow-run-bundle.v1");
    assert.equal(manifest.runTitle, "Demo run title");
    assert.equal(manifest.paths.runProjection, "projections/run.json");
    assert.equal(flowSnapshot.schema, "acpx.flow-definition-snapshot.v1");
    assert.deepEqual(flowSnapshot.run, { hasTitle: true });
    assert.deepEqual(flowSnapshot.permissions, {
      requiredMode: "approve-all",
      requireExplicitGrant: true,
      reason: "store test",
    });
    assert.equal(flowSnapshot.nodes.prepare?.nodeType, "action");
    assert.equal(flowSnapshot.nodes.prepare?.actionExecution, "function");
    assert.equal(flowSnapshot.nodes.prepare?.timeoutMs, 500);
    assert.equal(flowSnapshot.nodes.prepare?.heartbeatMs, 50);
    assert.equal(flowSnapshot.nodes.prepare?.statusDetail, "Preparing");
    assert.equal(flowSnapshot.nodes.prompt?.nodeType, "acp");
    assert.equal(flowSnapshot.nodes.prompt?.hasPrompt, true);
    assert.equal(flowSnapshot.nodes.prompt?.hasParse, true);
    assert.equal(flowSnapshot.nodes.prompt?.cwd?.mode, "dynamic");
    assert.deepEqual(flowSnapshot.nodes.prompt?.session, {
      handle: "review",
      isolated: true,
    });
    assert.equal(flowSnapshot.nodes.shell_step?.actionExecution, "shell");
    assert.equal(flowSnapshot.nodes.shell_step?.hasExec, true);
    assert.equal(flowSnapshot.nodes.shell_step?.hasParse, true);
    assert.equal(flowSnapshot.nodes.compute_step?.hasRun, true);
    assert.equal(flowSnapshot.nodes.checkpoint_step?.summary, "Review state");
    assert.equal(flowSnapshot.nodes.checkpoint_step?.hasRun, true);
    assert.equal(snapshot.runId, "run-123");
    assert.equal(snapshot.runTitle, "Demo run title");
    assert.equal(snapshot.currentNode, "prepare");
    assert.equal(live.runId, "run-123");
    assert.equal(live.runTitle, "Demo run title");
    assert.equal(live.currentAttemptId, "prepare#1");
    assert.equal(live.statusDetail, "Preparing");
    assert.deepEqual(steps, []);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "run_started");
    assert.equal(events[0]?.seq, 1);
    assert.equal(typeof events[0]?.at, "string");

    state.lastHeartbeatAt = "2026-03-26T00:00:02.000Z";
    state.statusDetail = "Still preparing";
    await store.writeLive(runDir, state, {
      scope: "node",
      type: "node_heartbeat",
      nodeId: "prepare",
      attemptId: "prepare#1",
      payload: {
        statusDetail: "Still preparing",
      },
    });

    const liveAfterHeartbeat = JSON.parse(
      await fs.readFile(path.join(runDir, "projections", "live.json"), "utf8"),
    ) as {
      lastHeartbeatAt?: string;
      statusDetail?: string;
    };
    const eventsAfterHeartbeat = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; nodeId?: string; seq?: number });

    assert.equal(liveAfterHeartbeat.lastHeartbeatAt, "2026-03-26T00:00:02.000Z");
    assert.equal(liveAfterHeartbeat.statusDetail, "Still preparing");
    assert.equal(eventsAfterHeartbeat.length, 2);
    assert.equal(eventsAfterHeartbeat[1]?.type, "node_heartbeat");
    assert.equal(eventsAfterHeartbeat[1]?.nodeId, "prepare");
    assert.equal(eventsAfterHeartbeat[1]?.seq, 2);

    state.status = "completed";
    state.finishedAt = "2026-03-26T00:00:03.000Z";
    state.steps = [
      {
        attemptId: "prepare#1",
        nodeId: "prepare",
        nodeType: "action",
        outcome: "ok",
        startedAt: "2026-03-26T00:00:01.000Z",
        finishedAt: "2026-03-26T00:00:03.000Z",
        promptText: null,
        rawText: null,
        output: { ok: true },
        session: null,
        agent: null,
      },
    ];
    await store.writeSnapshot(runDir, state, {
      scope: "run",
      type: "run_completed",
      payload: {
        status: "completed",
      },
    });

    const completedManifest = JSON.parse(
      await fs.readFile(path.join(runDir, "manifest.json"), "utf8"),
    ) as {
      status?: string;
      finishedAt?: string;
    };
    const completedSteps = JSON.parse(
      await fs.readFile(path.join(runDir, "projections", "steps.json"), "utf8"),
    ) as Array<{ nodeId?: string; outcome?: string }>;
    assert.equal(completedManifest.status, "completed");
    assert.equal(completedManifest.finishedAt, "2026-03-26T00:00:03.000Z");
    assert.equal(completedSteps[0]?.nodeId, "prepare");
    assert.equal(completedSteps[0]?.outcome, "ok");
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test("FlowRunStore writes artifacts with stable hashes and optional trace emission", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-artifacts-"));

  try {
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("run-artifacts");
    const state: FlowRunState = {
      runId: "run-artifacts",
      flowName: "artifacts",
      startedAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
    };
    const flow = defineFlow({
      name: "artifacts",
      startAt: "step",
      nodes: {
        step: action({
          run: () => ({ ok: true }),
        }),
      },
      edges: [],
    });

    await store.initializeRunBundle(runDir, {
      flow,
      state,
    });

    const jsonArtifact = await store.writeArtifact(
      runDir,
      state,
      { answer: 42 },
      {
        mediaType: "application/json",
        extension: "json",
        nodeId: "step",
        attemptId: "step#1",
        sessionId: "session-1",
      },
    );
    const bufferArtifact = await store.writeArtifact(runDir, state, Buffer.from("hello"), {
      mediaType: "text/plain",
      extension: ".txt",
      emitTrace: false,
    });
    const uintArtifact = await store.writeArtifact(runDir, state, new Uint8Array([1, 2, 3]), {
      mediaType: "application/octet-stream",
      extension: "bin",
      emitTrace: false,
    });
    const fallbackArtifact = await store.writeArtifact(runDir, state, 123, {
      mediaType: "text/plain",
      extension: "",
      emitTrace: false,
    });

    assert.match(jsonArtifact.path, /^artifacts\/sha256-[a-f0-9]+\.json$/);
    assert.match(bufferArtifact.path, /^artifacts\/sha256-[a-f0-9]+\.txt$/);
    assert.match(uintArtifact.path, /^artifacts\/sha256-[a-f0-9]+\.bin$/);
    assert.match(fallbackArtifact.path, /^artifacts\/sha256-[a-f0-9]+$/);

    assert.equal(
      await fs.readFile(path.join(runDir, ...jsonArtifact.path.split("/")), "utf8"),
      '{\n  "answer": 42\n}\n',
    );
    assert.equal(
      await fs.readFile(path.join(runDir, ...bufferArtifact.path.split("/")), "utf8"),
      "hello",
    );
    assert.deepEqual(
      Array.from(await fs.readFile(path.join(runDir, ...uintArtifact.path.split("/")))),
      [1, 2, 3],
    );
    assert.equal(
      await fs.readFile(path.join(runDir, ...fallbackArtifact.path.split("/")), "utf8"),
      "123",
    );

    const events = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; artifact?: { path?: string } });
    assert.deepEqual(
      events.map((event) => event.type),
      ["run_started", "artifact_written"],
    );
    assert.equal(events[1]?.artifact?.path, jsonArtifact.path);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test("FlowRunStore uses unique temp paths for concurrent live writes", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-race-"));
  const originalDateNow = Date.now;
  const failures: { phase: string; error: unknown }[] = [];
  Date.now = () => 1_700_000_000_000;

  try {
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("run-race");
    const baseState: FlowRunState = {
      runId: "run-race",
      flowName: "race",
      startedAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
      currentNode: "step",
      currentAttemptId: "step#1",
      currentNodeType: "action",
      currentNodeStartedAt: "2026-03-26T00:00:00.000Z",
      lastHeartbeatAt: "2026-03-26T00:00:00.000Z",
    };
    const flow = defineFlow({
      name: "race",
      startAt: "step",
      nodes: {
        step: action({
          run: () => ({ ok: true }),
        }),
      },
      edges: [],
    });
    await store.initializeRunBundle(runDir, {
      flow,
      state: baseState,
    });

    // Join both writes before cleanup so one rejection cannot race a sibling publication.
    const writeResults = await Promise.allSettled([
      store.writeLive(runDir, structuredClone(baseState), {
        scope: "node",
        type: "node_heartbeat",
        nodeId: "step",
        attemptId: "step#1",
        payload: {},
      }),
      store.writeLive(
        runDir,
        {
          ...structuredClone(baseState),
          statusDetail: "updated",
        },
        {
          scope: "node",
          type: "node_heartbeat",
          nodeId: "step",
          attemptId: "step#1",
          payload: {
            statusDetail: "updated",
          },
        },
      ),
    ]);

    for (const [index, result] of writeResults.entries()) {
      if (result.status === "rejected") {
        failures.push({ phase: `write ${index + 1}`, error: result.reason });
      }
    }

    if (failures.length === 0) {
      const live = JSON.parse(
        await fs.readFile(path.join(runDir, "projections", "live.json"), "utf8"),
      ) as {
        runId?: string;
      };
      const events = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });

      assert.equal(live.runId, "run-race");
      assert.equal(events.length, 3);
    }
  } catch (error) {
    failures.push({ phase: "test body", error });
  } finally {
    Date.now = originalDateNow;
    try {
      await fs.rm(outputRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push({ phase: "cleanup", error });
    }
  }
  // Keep cleanup errors alongside the original failures instead of replacing them.
  assert.deepEqual(failures, []);
});

test("FlowRunStore preserves bundled session event order across concurrent appends", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-session-events-"));

  try {
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("run-session-order");
    const state: FlowRunState = {
      runId: "run-session-order",
      flowName: "order",
      startedAt: "2026-03-26T00:00:00.000Z",
      updatedAt: "2026-03-26T00:00:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
    };
    const flow = defineFlow({
      name: "order",
      startAt: "step",
      nodes: {
        step: action({
          run: () => ({ ok: true }),
        }),
      },
      edges: [],
    });
    await store.initializeRunBundle(runDir, {
      flow,
      state,
    });

    const binding = {
      key: "main::/tmp/workspace",
      handle: "main",
      bundleId: "main-test",
      name: "main",
      agentName: "mock",
      agentCommand: "mock-agent",
      acpxRecordId: "record-123",
      acpSessionId: "session-123",
      cwd: "/tmp/workspace",
    };
    const now = "2026-03-26T00:00:00.000Z";
    const record: SessionRecord = {
      schema: SESSION_RECORD_SCHEMA,
      acpxRecordId: "record-123",
      acpSessionId: "session-123",
      agentCommand: "mock-agent",
      cwd: "/tmp/workspace",
      createdAt: now,
      lastUsedAt: now,
      lastSeq: 0,
      lastRequestId: undefined,
      eventLog: defaultSessionEventLog("record-123"),
      closed: false,
      closedAt: undefined,
      pid: undefined,
      agentStartedAt: undefined,
      protocolVersion: undefined,
      agentCapabilities: undefined,
      ...createSessionConversation(now),
      acpx: {},
    };

    await store.ensureSessionBundle(runDir, state, binding, record);

    const writes = Array.from({ length: 200 }, (_, index) =>
      store.appendSessionEvent(runDir, binding, "outbound", {
        jsonrpc: "2.0",
        id: index + 1,
        method: "test/message",
        params: { index: index + 1 },
      }),
    );
    const seqs = await Promise.all(writes);
    const bundledEvents = (
      await fs.readFile(path.join(runDir, "sessions", binding.bundleId, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number });

    assert.deepEqual(
      seqs,
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      bundledEvents.map((event) => event.seq),
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test("FlowRunStore excludes failed and pending appends from the persisted cursor", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-event-cursor-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const store = new FlowRunStore(outputRoot);
  const runDir = await store.createRunDir("cursor");
  const now = "2026-09-21T00:00:00.000Z";
  const state: FlowRunState = {
    runId: "cursor",
    flowName: "cursor",
    status: "running",
    startedAt: now,
    updatedAt: now,
    input: {},
    outputs: {},
    results: {},
    steps: [],
    sessionBindings: {},
  };
  const binding = {
    key: "capture",
    handle: "capture",
    bundleId: "capture",
    name: "capture",
    agentName: "unused",
    agentCommand: "unused",
    cwd: outputRoot,
    acpxRecordId: "record",
    acpSessionId: "provider",
  };
  const record = createSyntheticSessionRecord({
    binding,
    createdAt: now,
    updatedAt: now,
    conversation: createSessionConversation(now),
    acpxState: undefined,
    lastSeq: 999,
  });
  await store.ensureSessionBundle(runDir, state, binding, record);
  const eventsPath = path.join(runDir, "sessions", binding.bundleId, "events.ndjson");
  const savedPath = `${eventsPath}.saved`;
  const append = () =>
    store.appendSessionEvent(runDir, binding, "inbound", {
      jsonrpc: "2.0",
      method: "test/message",
      params: {},
    });
  const readCursor = async () => {
    await store.writeSessionRecord(runDir, state, binding, record);
    const saved = JSON.parse(
      await fs.readFile(path.join(runDir, "sessions", binding.bundleId, "record.json"), "utf8"),
    ) as SessionRecord;
    return saved.lastSeq;
  };
  assert.equal(await readCursor(), 0);

  // Force a real append refusal while leaving record publication available.
  await fs.rename(eventsPath, savedPath);
  await fs.mkdir(eventsPath);
  try {
    await assert.rejects(append());
  } finally {
    await fs.rmdir(eventsPath);
    await fs.rename(savedPath, eventsPath);
  }
  assert.equal(await fs.readFile(eventsPath, "utf8"), "");
  assert.equal(await readCursor(), 0, "a rejected append is not a replay boundary");

  assert.deepEqual(await Promise.all([append(), append()]), [2, 3]);
  assert.equal(await readCursor(), 3);
  const seqs = (await fs.readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
  assert.deepEqual(seqs, [2, 3], "failed reservations must not reuse a later event's identity");

  let release!: () => void;
  let enter!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const harness = store as unknown as {
    appendJsonLine(file: string, value: unknown): Promise<void>;
  };
  const original = harness.appendJsonLine.bind(store);
  t.mock.method(harness, "appendJsonLine", async (file: string, value: unknown) => {
    enter();
    await held;
    await original(file, value);
  });
  const pending = append();
  try {
    await entered;
    assert.equal(await readCursor(), 3, "a pending append is not a replay boundary");
    release();
    assert.equal(await pending, 4);
    assert.equal(await readCursor(), 4);
  } finally {
    release();
    await pending;
  }
});
