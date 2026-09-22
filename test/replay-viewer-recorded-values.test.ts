import assert from "node:assert/strict";
import test from "node:test";
import type { BundleReader } from "../examples/flows/replay-viewer/src/lib/bundle-reader.js";
import { loadRunBundle } from "../examples/flows/replay-viewer/src/lib/load-bundle.js";
import { formatDuration } from "../examples/flows/replay-viewer/src/lib/view-model-format.js";
import { buildPlaybackTimeline } from "../examples/flows/replay-viewer/src/lib/view-model-playback.js";
import type {
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowStepRecord,
} from "../examples/flows/replay-viewer/src/types.js";

const timestamp = "2026-09-22T10:00:00.000Z";

function step(nodeId: string, attempt: number, startedAt = timestamp): FlowStepRecord {
  return {
    attemptId: `${nodeId}#${attempt}`,
    nodeId,
    nodeType: "compute",
    outcome: "ok",
    startedAt,
    finishedAt: startedAt,
    promptText: null,
    rawText: null,
    output: { marker: `${nodeId}-${attempt}` },
    session: null,
    agent: null,
  };
}

async function loadRecordedSteps(steps: FlowStepRecord[]) {
  const manifest: FlowRunManifest = {
    schema: "acpx.flow-run-bundle.v1",
    runId: "synthetic-recorded-values",
    flowName: "synthetic-recorded-values",
    startedAt: timestamp,
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
  };
  const flow: FlowDefinitionSnapshot = {
    schema: "acpx.flow-definition-snapshot.v1",
    name: manifest.flowName,
    startAt: steps[0]?.nodeId ?? "empty",
    nodes: Object.fromEntries(
      steps.map((value) => [value.nodeId, { nodeType: "compute", hasRun: true }]),
    ),
    edges: [],
  };
  const run: FlowRunState = {
    runId: manifest.runId,
    flowName: manifest.flowName,
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "completed",
    input: {},
    outputs: {},
    results: {},
    steps,
    sessionBindings: {},
  };
  const event = (seq: number) =>
    JSON.stringify({
      seq,
      at: timestamp,
      scope: "run",
      type: "synthetic",
      runId: run.runId,
      payload: {},
    });
  const files = new Map<string, string>([
    ["manifest.json", JSON.stringify(manifest)],
    ["flow.json", JSON.stringify(flow)],
    ["projections/run.json", JSON.stringify(run)],
    ["projections/steps.json", JSON.stringify(steps)],
    ["trace.ndjson", `${event(2)}\n${event(1)}\n`],
  ]);
  const reader: BundleReader = {
    sourceType: "local",
    label: "synthetic-recorded-values",
    readText: async (relativePath) => {
      const contents = files.get(relativePath);
      if (contents === undefined) {
        throw new Error(`Missing synthetic file: ${relativePath}`);
      }
      return contents;
    },
  };
  return await loadRunBundle(reader);
}

for (const [name, steps] of [
  ["same-time reverse-alphabetic nodes", [step("z_first", 1), step("a_second", 1)]],
  ["same-time per-node counters", [step("loop", 2), step("loop", 10)]],
  [
    "ordinary increasing timestamps",
    [step("z_first", 1), step("a_second", 1, "2026-09-22T10:00:00.001Z")],
  ],
  ["clock moving backward", [step("z_first", 1, "2026-09-22T10:00:01.000Z"), step("a_second", 1)]],
  ["an empty recorded run", []],
] as const) {
  test(`viewer retains recorded order for ${name}`, async () => {
    const source = [...steps];
    const expected = source.map((value) => value.attemptId);
    const bundle = await loadRecordedSteps(source);
    assert.deepEqual(
      bundle.steps.map((value) => value.attemptId),
      expected,
    );
    assert.deepEqual(
      bundle.run.steps.map((value) => value.attemptId),
      expected,
    );
    assert.deepEqual(
      buildPlaybackTimeline(bundle).segments.map((value) => value.nodeId),
      source.map((value) => value.nodeId),
    );
    assert.deepEqual(
      bundle.trace.map((value) => value.seq),
      [1, 2],
      "trace retains its independent seq ordering",
    );
  });
}

for (const [durationMs, expected] of [
  [60_000, "1m 0s"],
  [119_499, "1m 59s"],
  [119_500, "2m 0s"],
  [119_999, "2m 0s"],
  [120_000, "2m 0s"],
  [179_499, "2m 59s"],
  [179_500, "3m 0s"],
] as const) {
  test(`viewer formats ${durationMs}ms as ${expected}`, () => {
    assert.equal(formatDuration(durationMs), expected);
  });
}
