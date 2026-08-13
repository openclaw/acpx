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

test("listRunBundles ignores bundles whose manifest paths escape the bundle", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-list-escape-"));
  const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-secret-"));

  try {
    const secretFile = path.join(secretDir, "secret.json");
    await fs.writeFile(secretFile, JSON.stringify({ runTitle: "leaked", status: "completed" }));

    const runId = "2026-03-27T090000000Z-malicious";
    const runDir = path.join(runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({
        schema: "acpx.flow-run-bundle.v1",
        runId,
        flowName: "flow-malicious",
        startedAt: "2026-03-27T09:00:00.000Z",
        status: "completed",
        traceSchema: "acpx.flow-trace-event.v1",
        paths: {
          flow: "flow.json",
          trace: "trace.ndjson",
          runProjection: path.relative(runDir, secretFile),
          liveProjection: "projections/live.json",
          stepsProjection: "projections/steps.json",
          sessionsDir: "sessions",
          artifactsDir: "artifacts",
        },
        sessions: [],
      }),
    );

    const runs = await listRunBundles(runsDir);

    assert.deepEqual(runs, []);
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(secretDir, { recursive: true, force: true });
  }
});

test("listRunBundles ignores bundles whose projection symlink escapes the bundle", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-list-symlink-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-outside-"));

  try {
    const runId = "2026-03-27T100000000Z-symlink";
    const runDir = path.join(runsDir, runId);
    const outsideFile = path.join(outsideDir, "outside.json");
    await fs.mkdir(path.join(runDir, "projections"), { recursive: true });
    await fs.writeFile(outsideFile, JSON.stringify({ runTitle: "leaked", status: "completed" }));
    await fs.symlink(outsideFile, path.join(runDir, "projections", "run.json"));
    await fs.writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({
        schema: "acpx.flow-run-bundle.v1",
        runId,
        flowName: "flow-symlink",
        startedAt: "2026-03-27T10:00:00.000Z",
        status: "completed",
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

    assert.deepEqual(await listRunBundles(runsDir), []);
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("listRunBundles ignores bundles whose manifest symlink escapes the bundle", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-manifest-symlink-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-manifest-outside-"));

  try {
    const runId = "2026-03-27T110000000Z-manifest-symlink";
    const runDir = path.join(runsDir, runId);
    const outsideManifest = path.join(outsideDir, "manifest.json");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      outsideManifest,
      JSON.stringify({
        schema: "acpx.flow-run-bundle.v1",
        runId,
        flowName: "flow-manifest-symlink",
        startedAt: "2026-03-27T11:00:00.000Z",
        status: "completed",
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
    await fs.symlink(outsideManifest, path.join(runDir, "manifest.json"));

    assert.deepEqual(await listRunBundles(runsDir), []);
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("resolveRunBundleFilePath rejects traversal outside a run bundle", async () => {
  const runsDir = path.join(os.tmpdir(), "acpx-run-list");

  await assert.rejects(
    resolveRunBundleFilePath(runsDir, "run-id", "../manifest.json"),
    /not allowed/,
  );
  await assert.rejects(
    resolveRunBundleFilePath(runsDir, "run-id", "/tmp/manifest.json"),
    /not allowed/,
  );
  await assert.rejects(
    resolveRunBundleFilePath(runsDir, "../sessions", "session.json"),
    /outside runs directory/,
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
