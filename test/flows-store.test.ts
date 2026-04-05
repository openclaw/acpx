import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineFlow, action, type FlowRunState } from "../src/flows/runtime.js";
import { FlowRunStore, flowRunsBaseDir } from "../src/flows/store.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SESSION_RECORD_SCHEMA, type SessionRecord } from "../src/types.js";

test("flowRunsBaseDir defaults under the acpx home directory", () => {
  assert.equal(flowRunsBaseDir("/tmp/home"), path.join("/tmp/home", ".acpx", "flows", "runs"));
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
      startAt: "prepare",
      nodes: {
        prepare: action({
          run: () => ({ ok: true }),
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
      nodes: Record<string, { nodeType: string; actionExecution?: string }>;
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
    assert.equal(flowSnapshot.nodes.prepare?.nodeType, "action");
    assert.equal(flowSnapshot.nodes.prepare?.actionExecution, "function");
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
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test("FlowRunStore uses unique temp paths for concurrent live writes", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-race-"));
  const originalDateNow = Date.now;
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

    await Promise.all([
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
  } finally {
    Date.now = originalDateNow;
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
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
