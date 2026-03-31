import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listRunBundles,
  resolveRunBundleFilePath,
} from "../examples/flows/replay-viewer/server/run-bundles.js";

test("listRunBundles returns newest valid bundles first", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-list-"));

  try {
    await writeRunBundle(runsDir, {
      runId: "2026-03-27T060000000Z-example-a",
      flowName: "flow-a",
      runTitle: "PR-triage-acpx-171",
      status: "completed",
      startedAt: "2026-03-27T06:00:00.000Z",
      currentNode: "done",
    });
    await writeRunBundle(runsDir, {
      runId: "2026-03-27T070000000Z-example-b",
      flowName: "flow-b",
      status: "running",
      startedAt: "2026-03-27T07:00:00.000Z",
      currentNode: "extract_intent",
    });
    await fs.mkdir(path.join(runsDir, "not-a-bundle"));

    const runs = await listRunBundles(runsDir);

    assert.deepEqual(
      runs.map((run) => run.runId),
      ["2026-03-27T070000000Z-example-b", "2026-03-27T060000000Z-example-a"],
    );
    assert.equal(runs[0]?.currentNode, "extract_intent");
    assert.equal(runs[1]?.flowName, "flow-a");
    assert.equal(runs[1]?.runTitle, "PR-triage-acpx-171");
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("listRunBundles prefers live status over stale run projections", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-list-live-"));

  try {
    await writeRunBundle(runsDir, {
      runId: "2026-03-27T080000000Z-example-live",
      flowName: "flow-live",
      projectedStatus: "completed",
      status: "running",
      startedAt: "2026-03-27T08:00:00.000Z",
      currentNode: "extract_intent",
      liveUpdatedAt: "2026-03-27T08:05:00.000Z",
    });

    const [run] = await listRunBundles(runsDir);

    assert.equal(run?.status, "running");
    assert.equal(run?.currentNode, "extract_intent");
    assert.equal(run?.updatedAt, "2026-03-27T08:05:00.000Z");
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("resolveRunBundleFilePath rejects traversal outside a run bundle", () => {
  const runsDir = path.join(os.tmpdir(), "acpx-run-list");

  assert.throws(
    () => resolveRunBundleFilePath(runsDir, "run-id", "../manifest.json"),
    /not allowed/,
  );
  assert.throws(
    () => resolveRunBundleFilePath(runsDir, "run-id", "/tmp/manifest.json"),
    /not allowed/,
  );
});

async function writeRunBundle(
  runsDir: string,
  options: {
    runId: string;
    flowName: string;
    runTitle?: string;
    status: "running" | "waiting" | "completed" | "failed" | "timed_out";
    projectedStatus?: "running" | "waiting" | "completed" | "failed" | "timed_out";
    startedAt: string;
    currentNode?: string;
    liveUpdatedAt?: string;
  },
): Promise<void> {
  const runDir = path.join(runsDir, options.runId);
  const projectionsDir = path.join(runDir, "projections");
  await fs.mkdir(projectionsDir, { recursive: true });

  await fs.writeFile(
    path.join(runDir, "manifest.json"),
    JSON.stringify({
      schema: "acpx.flow-run-bundle.v1",
      runId: options.runId,
      flowName: options.flowName,
      runTitle: options.runTitle,
      startedAt: options.startedAt,
      status: options.status,
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
    }),
  );

  await fs.writeFile(
    path.join(projectionsDir, "run.json"),
    JSON.stringify({
      runId: options.runId,
      flowName: options.flowName,
      runTitle: options.runTitle,
      startedAt: options.startedAt,
      updatedAt: options.startedAt,
      status: options.projectedStatus ?? options.status,
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
      currentNode: options.currentNode,
    }),
  );

  await fs.writeFile(
    path.join(projectionsDir, "live.json"),
    JSON.stringify({
      runId: options.runId,
      flowName: options.flowName,
      runTitle: options.runTitle,
      startedAt: options.startedAt,
      updatedAt: options.liveUpdatedAt ?? options.startedAt,
      status: options.status,
      currentNode: options.currentNode,
    }),
  );
}
