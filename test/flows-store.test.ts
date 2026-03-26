import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FlowRunState } from "../src/flows/runtime.js";
import { FlowRunStore, flowRunsBaseDir } from "../src/flows/store.js";

test("flowRunsBaseDir defaults under the acpx home directory", () => {
  assert.equal(flowRunsBaseDir("/tmp/home"), path.join("/tmp/home", ".acpx", "flows", "runs"));
});

test("FlowRunStore writes snapshots, live state, and events", async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-store-test-"));

  try {
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("run-123");
    const state: FlowRunState = {
      runId: "run-123",
      flowName: "demo",
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
      currentNodeKind: "action",
      currentNodeStartedAt: "2026-03-26T00:00:01.000Z",
      lastHeartbeatAt: "2026-03-26T00:00:01.000Z",
      statusDetail: "Preparing",
    };

    await store.writeSnapshot(runDir, state, {
      type: "run_started",
    });

    const snapshot = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")) as {
      runId: string;
      currentNode?: string;
      statusDetail?: string;
    };
    const live = JSON.parse(await fs.readFile(path.join(runDir, "live.json"), "utf8")) as {
      runId: string;
      currentNode?: string;
      statusDetail?: string;
    };
    const events = (await fs.readFile(path.join(runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; at?: string });

    assert.equal(snapshot.runId, "run-123");
    assert.equal(snapshot.currentNode, "prepare");
    assert.equal(live.runId, "run-123");
    assert.equal(live.statusDetail, "Preparing");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "run_started");
    assert.equal(typeof events[0]?.at, "string");

    state.lastHeartbeatAt = "2026-03-26T00:00:02.000Z";
    state.statusDetail = "Still preparing";
    await store.writeLive(runDir, state, {
      type: "node_heartbeat",
      nodeId: "prepare",
    });

    const liveAfterHeartbeat = JSON.parse(
      await fs.readFile(path.join(runDir, "live.json"), "utf8"),
    ) as {
      lastHeartbeatAt?: string;
      statusDetail?: string;
    };
    const eventsAfterHeartbeat = (await fs.readFile(path.join(runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; nodeId?: string });

    assert.equal(liveAfterHeartbeat.lastHeartbeatAt, "2026-03-26T00:00:02.000Z");
    assert.equal(liveAfterHeartbeat.statusDetail, "Still preparing");
    assert.equal(eventsAfterHeartbeat.length, 2);
    assert.equal(eventsAfterHeartbeat[1]?.type, "node_heartbeat");
    assert.equal(eventsAfterHeartbeat[1]?.nodeId, "prepare");
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
      currentNodeKind: "action",
      currentNodeStartedAt: "2026-03-26T00:00:00.000Z",
      lastHeartbeatAt: "2026-03-26T00:00:00.000Z",
    };

    await Promise.all([
      store.writeLive(runDir, structuredClone(baseState), {
        type: "node_heartbeat",
        nodeId: "step",
      }),
      store.writeLive(
        runDir,
        {
          ...structuredClone(baseState),
          statusDetail: "updated",
        },
        {
          type: "node_detail",
          nodeId: "step",
        },
      ),
    ]);

    const live = JSON.parse(await fs.readFile(path.join(runDir, "live.json"), "utf8")) as {
      runId?: string;
    };
    const events = (await fs.readFile(path.join(runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string });

    assert.equal(live.runId, "run-race");
    assert.equal(events.length, 2);
  } finally {
    Date.now = originalDateNow;
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});
