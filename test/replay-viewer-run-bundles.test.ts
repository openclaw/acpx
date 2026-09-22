import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listRunBundles,
  readRunBundleFile,
  readRunBundleTextFile,
} from "../examples/flows/replay-viewer/server/run-bundles.js";

test(
  "viewer reads reject FIFOs instead of waiting for a producer",
  { skip: process.platform === "win32" },
  async () => {
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-fifo-"));
    try {
      await fs.mkdir(path.join(runsDir, "run"));
      execFileSync("mkfifo", [path.join(runsDir, "run", "pipe")]);
      const moduleUrl = new URL(
        "../examples/flows/replay-viewer/server/run-bundles.js",
        import.meta.url,
      ).href;
      const probe = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      const { readRunBundleFile } = await import(process.argv[1]);
      try {
        await readRunBundleFile(process.argv[2], "run", "pipe");
        process.exitCode = 1;
      } catch { process.stdout.write("rejected"); }
    `,
          moduleUrl,
          runsDir,
        ],
        { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
      );
      assert.ifError(probe.error);
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, "rejected");
    } finally {
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  },
);

test(
  "viewer reads preserve contained aliases, literal names, and large files within each bundle",
  { skip: process.platform === "win32" },
  async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-roots-"));
    try {
      const runsDir = path.join(parent, "runs");
      const bundle = path.join(runsDir, "~");
      const other = path.join(parent, "outside");
      await fs.mkdir(bundle, { recursive: true });
      await fs.mkdir(other);
      const content = "x".repeat(16 * 1024 * 1024 + 1);
      const file = path.join(bundle, "..large");
      await fs.writeFile(file, content);
      await fs.symlink(file, path.join(bundle, "alias"));
      await fs.link(file, path.join(bundle, "c:hardlink"));
      assert.equal((await readRunBundleFile(runsDir, "~", "alias")).byteLength, content.length);
      assert.equal(await readRunBundleTextFile(runsDir, "~", "c:hardlink"), content);
      await fs.writeFile(path.join(other, "data"), "must not read");
      await fs.symlink(other, path.join(runsDir, "escape"));
      await fs.symlink(path.join(other, "data"), path.join(bundle, "escape"));
      await assert.rejects(readRunBundleFile(runsDir, "escape", "data"));
      await assert.rejects(readRunBundleFile(runsDir, "~", "escape"));
      const sibling = path.join(runsDir, "sibling");
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, "data"), "other bundle");
      await fs.symlink(path.join(sibling, "data"), path.join(bundle, "cross-bundle"));
      await assert.rejects(readRunBundleFile(runsDir, "~", "cross-bundle"));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  },
);

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

test("listRunBundles skips corrupt sort fields without hiding valid runs", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-invalid-sort-"));
  try {
    for (const runId of ["bad-id", "bad-time", "valid"]) {
      await writeRunBundle(runsDir, {
        runId,
        flowName: "synthetic",
        status: "completed",
        startedAt: "2026-09-15T00:00:00.000Z",
      });
      if (runId !== "valid") {
        const manifestPath = path.join(runsDir, runId, "manifest.json");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
        manifest[runId === "bad-id" ? "runId" : "startedAt"] =
          runId === "bad-id" ? 7 : { toString: null, valueOf: null };
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
      }
    }
    assert.deepEqual(
      (await listRunBundles(runsDir)).map((run) => run.runId),
      ["valid"],
    );
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

test("readRunBundleFile rejects traversal outside a run bundle", async () => {
  const runsDir = path.join(os.tmpdir(), "acpx-run-list");

  await assert.rejects(readRunBundleFile(runsDir, "run-id", "../manifest.json"), /not allowed/);
  await assert.rejects(readRunBundleFile(runsDir, "run-id", "/tmp/manifest.json"), /not allowed/);
  await assert.rejects(
    readRunBundleFile(runsDir, "../sessions", "session.json"),
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

test("listRunBundles finds a valid older run behind a full quota of empty directories", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-valid-quota-"));
  const runId = "2026-09-21T000000000Z-valid";
  try {
    await writeRunBundle(runsDir, {
      runId,
      flowName: "synthetic-quota",
      runTitle: "Synthetic retained run",
      status: "completed",
      startedAt: "2026-09-21T00:00:00.000Z",
    });
    for (let index = 0; index < 24; index += 1) {
      await fs.mkdir(
        path.join(runsDir, `2026-09-22T000000000Z-empty-${String(index).padStart(2, "0")}`),
      );
    }
    // Establish that this same bundle is readable even on the old candidate cap.
    assert.deepEqual(
      (await listRunBundles(runsDir, 25)).map((run) => run.runId),
      [runId],
    );
    const runs = await listRunBundles(runsDir);
    assert.deepEqual(
      runs.map((run) => run.runId),
      [runId],
    );
    assert.equal(runs[0]?.runTitle, "Synthetic retained run");
    assert.equal(runs[0]?.status, "completed");
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("listRunBundles fills the requested valid quota without changing selection or display order", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-quota-order-"));
  try {
    for (const [runId, startedAt] of [
      ["y-selected", "2026-09-20T00:00:00.000Z"],
      ["w-selected", "2026-09-21T00:00:00.000Z"],
      ["v-selected", "2026-09-21T00:00:00.000Z"],
      ["u-not-selected", "2026-09-22T00:00:00.000Z"],
    ]) {
      await writeRunBundle(runsDir, {
        runId,
        flowName: "synthetic-order",
        status: "completed",
        startedAt,
      });
    }
    const expected = ["w-selected", "v-selected", "y-selected"];
    // Existing behavior chooses by directory ID, then displays by date and ID.
    assert.deepEqual(
      (await listRunBundles(runsDir, 3)).map((run) => run.runId),
      expected,
    );
    await fs.mkdir(path.join(runsDir, "z-malformed"));
    await fs.writeFile(path.join(runsDir, "z-malformed", "manifest.json"), "{unfinished");
    await writeRunBundle(runsDir, {
      runId: "x-incomplete",
      flowName: "synthetic-incomplete",
      status: "running",
      startedAt: "2026-09-22T00:00:00.000Z",
    });
    await fs.unlink(path.join(runsDir, "x-incomplete", "projections", "run.json"));
    assert.deepEqual(
      (await listRunBundles(runsDir, 3)).map((run) => run.runId),
      expected,
    );
    assert.deepEqual(
      (await listRunBundles(runsDir, 1)).map((run) => run.runId),
      ["y-selected"],
    );
    assert.deepEqual(await listRunBundles(runsDir, 0), []);
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});

test("listRunBundles still returns at most 24 valid summaries after skipping newer incomplete runs", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-default-quota-"));
  try {
    const ids: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      const runId = `2026-09-21T000000000Z-valid-${String(index).padStart(2, "0")}`;
      ids.push(runId);
      await writeRunBundle(runsDir, {
        runId,
        flowName: "synthetic-cap",
        status: "completed",
        startedAt: "2026-09-21T00:00:00.000Z",
      });
    }
    const expected = ids.toReversed().slice(0, 24);
    assert.deepEqual(
      (await listRunBundles(runsDir)).map((run) => run.runId),
      expected,
    );
    for (let index = 0; index < 25; index += 1) {
      await fs.mkdir(
        path.join(runsDir, `2026-09-22T000000000Z-empty-${String(index).padStart(2, "0")}`),
      );
    }
    const runs = await listRunBundles(runsDir);
    assert.equal(runs.length, 24);
    assert.deepEqual(
      runs.map((run) => run.runId),
      expected,
    );
  } finally {
    await fs.rm(runsDir, { recursive: true, force: true });
  }
});
