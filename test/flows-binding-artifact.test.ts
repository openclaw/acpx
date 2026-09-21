import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFilesystemBundleReader } from "../examples/flows/replay-viewer/server/filesystem-bundle-reader.js";
import { loadRunBundle } from "../examples/flows/replay-viewer/src/lib/load-bundle.js";
import { compute, defineFlow } from "../src/flows/runtime.js";
import { FlowRunStore } from "../src/flows/store.js";
import type {
  FlowArtifactRef,
  FlowManifestSessionEntry,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowTraceEvent,
} from "../src/flows/types.js";
import { createDeferred } from "../src/runtime/engine/turn.js";
import { makeSessionRecord, withTempDir } from "./runtime-test-helpers.js";

type BindingFixture = {
  store: FlowRunStore;
  state: FlowRunState;
  runDir: string;
  outputRoot: string;
  cwd: string;
};

// Earlier v1 binding refs omitted bytes. Hash integrity remains mandatory.
type BindingArtifact = Omit<FlowArtifactRef, "bytes"> & { bytes?: number };

async function withBindingFixture(run: (fixture: BindingFixture) => Promise<void>): Promise<void> {
  await withTempDir("acpx-binding-artifact-", async (directory) => {
    const outputRoot = path.join(directory, "runs");
    const cwd = path.join(directory, "workspace");
    await fs.mkdir(cwd);
    const store = new FlowRunStore(outputRoot);
    const runDir = await store.createRunDir("binding-artifact-run");
    const state: FlowRunState = {
      runId: "binding-artifact-run",
      flowName: "binding-artifact-fixture",
      startedAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      status: "running",
      input: {},
      outputs: {},
      results: {},
      steps: [],
      sessionBindings: {},
    };
    try {
      await store.initializeRunBundle(runDir, {
        flow: defineFlow({
          name: state.flowName,
          startAt: "done",
          nodes: { done: compute({ run: () => "unused store fixture" }) },
          edges: [],
        }),
        state,
      });
      await run({ store, state, runDir, outputRoot, cwd });
    } finally {
      store.releaseRun(runDir);
    }
  });
}

function bindingFor(fixture: BindingFixture, name: string): FlowSessionBinding {
  return {
    key: `${name}::fixture`,
    handle: name,
    bundleId: `${name}-bundle`,
    name,
    agentName: "synthetic",
    agentCommand: "synthetic-agent",
    agentArgv: ["synthetic-agent", "--fixture"],
    cwd: fixture.cwd,
    acpxRecordId: `${name}-record`,
    acpSessionId: `${name}-provider`,
  };
}

async function publishBinding(fixture: BindingFixture, binding: FlowSessionBinding): Promise<void> {
  fixture.state.sessionBindings[binding.key] = binding;
  await fixture.store.ensureSessionBundle(
    fixture.runDir,
    fixture.state,
    binding,
    makeSessionRecord({
      acpxRecordId: binding.acpxRecordId,
      acpSessionId: binding.acpSessionId,
      agentSessionId: binding.agentSessionId,
      agentCommand: binding.agentCommand,
      agentArgv: binding.agentArgv,
      cwd: binding.cwd,
      name: binding.name,
      title: `Current ${binding.acpSessionId}`,
    }),
  );
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

function referencedFile(runDir: string, reference: string): string {
  assert.equal(path.isAbsolute(reference), false);
  const file = path.resolve(runDir, ...reference.split("/"));
  const relative = path.relative(runDir, file);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes(".."));
  return file;
}

async function manifestFor(fixture: BindingFixture): Promise<FlowRunManifest> {
  return await readJson<FlowRunManifest>(path.join(fixture.runDir, "manifest.json"));
}

async function boundEvents(fixture: BindingFixture): Promise<FlowTraceEvent[]> {
  const manifest = await manifestFor(fixture);
  return (await fs.readFile(referencedFile(fixture.runDir, manifest.paths.trace), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FlowTraceEvent)
    .filter((event) => event.type === "session_bound");
}

async function entryFor(
  fixture: BindingFixture,
  bundleId: string,
): Promise<FlowManifestSessionEntry> {
  const entry = (await manifestFor(fixture)).sessions.find((session) => session.id === bundleId);
  assert.ok(entry);
  assert.equal(entry.bindingPath, `sessions/${bundleId}/binding.json`);
  assert.equal(entry.recordPath, `sessions/${bundleId}/record.json`);
  assert.equal(entry.eventsPath, `sessions/${bundleId}/events.ndjson`);
  return entry;
}

function bindingReference(event: FlowTraceEvent): BindingArtifact {
  const reference = event.payload.bindingArtifact as BindingArtifact | undefined;
  assert.ok(reference);
  assert.equal(typeof reference.path, "string");
  assert.equal(reference.mediaType, "application/json");
  assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  return reference;
}

async function readBindingArtifact(fixture: BindingFixture, event: FlowTraceEvent) {
  const reference = bindingReference(event);
  const bytes = await fs.readFile(referencedFile(fixture.runDir, reference.path));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    reference.sha256,
    "the historical reference must still describe the bytes at its own path",
  );
  if (reference.bytes !== undefined) {
    assert.equal(reference.bytes, bytes.byteLength);
  }
  const binding = JSON.parse(bytes.toString("utf8")) as FlowSessionBinding;
  assert.equal(event.sessionId, binding.bundleId);
  assert.equal(event.payload.sessionId, binding.bundleId);
  assert.equal(event.payload.handle, binding.handle);
  return { reference, bytes, binding };
}

async function onlyBoundEvent(fixture: BindingFixture, bundleId: string): Promise<FlowTraceEvent> {
  const matches = (await boundEvents(fixture)).filter((event) => event.sessionId === bundleId);
  assert.equal(matches.length, 1, "each bundle keeps one original session_bound receipt");
  return matches[0];
}

test("isolated rebinding preserves the initial artifact while current IDs advance", async () => {
  await withBindingFixture(async (fixture) => {
    const initial: FlowSessionBinding = {
      ...bindingFor(fixture, "isolated"),
      key: "isolated::work#1",
      acpxRecordId: "isolated::work#1",
      acpSessionId: "isolated::work#1",
    };
    await publishBinding(fixture, initial);
    const event = await onlyBoundEvent(fixture, initial.bundleId);
    const snapshot = await readBindingArtifact(fixture, event);
    assert.deepEqual(snapshot.binding, initial);

    const current = {
      ...initial,
      acpxRecordId: "actual-provider",
      acpSessionId: "actual-provider",
    };
    await publishBinding(fixture, current);
    await publishBinding(fixture, current);
    const manifest = await manifestFor(fixture);
    assert.equal(manifest.sessions.length, 1);
    const entry = await entryFor(fixture, current.bundleId);
    assert.deepEqual(
      await readJson<FlowSessionBinding>(referencedFile(fixture.runDir, entry.bindingPath)),
      current,
    );
    assert.deepEqual(
      await boundEvents(fixture),
      [event],
      "rebinding must not rewrite the old receipt",
    );
    const after = await readBindingArtifact(fixture, event);
    assert.deepEqual(after.bytes, snapshot.bytes);
    assert.deepEqual(after.binding, initial);
    assert.notEqual(after.reference.path, entry.bindingPath);
    assert.equal(after.reference.bytes, snapshot.bytes.byteLength);
    const trace = (await fs.readFile(path.join(fixture.runDir, "trace.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as FlowTraceEvent);
    assert.deepEqual(
      trace.map((item) => item.type),
      ["run_started", "session_bound"],
    );
  });
});

test("persistent agent metadata can rebind without changing a historical snapshot", async () => {
  await withBindingFixture(async (fixture) => {
    const initial = { ...bindingFor(fixture, "persistent"), agentSessionId: "native-before" };
    await publishBinding(fixture, initial);
    const event = await onlyBoundEvent(fixture, initial.bundleId);
    const snapshot = await readBindingArtifact(fixture, event);
    const current = { ...initial, agentSessionId: "native-after-load" };
    await publishBinding(fixture, current);

    const entry = await entryFor(fixture, current.bundleId);
    const projected = await readJson<FlowSessionBinding>(
      referencedFile(fixture.runDir, entry.bindingPath),
    );
    assert.deepEqual(projected, current);
    assert.equal(projected.acpxRecordId, initial.acpxRecordId);
    assert.equal(projected.acpSessionId, initial.acpSessionId);
    assert.deepEqual(await boundEvents(fixture), [event]);
    const after = await readBindingArtifact(fixture, event);
    assert.deepEqual(after.bytes, snapshot.bytes);
    assert.deepEqual(after.binding, initial);
  });
});

test("distinct bundles retain their own initial binding artifacts across later updates", async () => {
  await withBindingFixture(async (fixture) => {
    const initial = [bindingFor(fixture, "first"), bindingFor(fixture, "second")];
    for (const binding of initial) {
      await publishBinding(fixture, binding);
    }
    const saved = await Promise.all(
      initial.map(async (binding) => {
        const event = await onlyBoundEvent(fixture, binding.bundleId);
        return { binding, event, snapshot: await readBindingArtifact(fixture, event) };
      }),
    );
    for (const { binding } of saved.toReversed()) {
      await publishBinding(fixture, { ...binding, agentSessionId: `updated-${binding.handle}` });
    }

    assert.equal((await manifestFor(fixture)).sessions.length, 2);
    assert.deepEqual(
      await boundEvents(fixture),
      saved.map(({ event }) => event),
    );
    for (const { binding, event, snapshot } of saved) {
      const after = await readBindingArtifact(fixture, event);
      assert.deepEqual(after.bytes, snapshot.bytes);
      assert.deepEqual(after.binding, binding);
      const entry = await entryFor(fixture, binding.bundleId);
      const current = await readJson<FlowSessionBinding>(
        referencedFile(fixture.runDir, entry.bindingPath),
      );
      assert.equal(current.agentSessionId, `updated-${binding.handle}`);
    }
    assert.notEqual(saved[0].snapshot.reference.path, saved[1].snapshot.reference.path);
  });
});

test("the actual viewer loader reads the current binding while keeping the historical trace ref", async () => {
  await withBindingFixture(async (fixture) => {
    const initial: FlowSessionBinding = {
      ...bindingFor(fixture, "viewer"),
      acpxRecordId: "isolated::viewer#1",
      acpSessionId: "isolated::viewer#1",
    };
    await publishBinding(fixture, initial);
    const event = await onlyBoundEvent(fixture, initial.bundleId);
    const current = {
      ...initial,
      acpxRecordId: "viewer-actual-provider",
      acpSessionId: "viewer-actual-provider",
      agentSessionId: "viewer-native-id",
    };
    await publishBinding(fixture, current);
    fixture.state.status = "completed";
    fixture.state.finishedAt = "2026-09-21T00:00:01.000Z";
    await fixture.store.writeSnapshot(fixture.runDir, fixture.state, {
      scope: "run",
      type: "run_completed",
      payload: { status: "completed" },
    });

    const reader = createFilesystemBundleReader(fixture.outputRoot, { runId: fixture.state.runId });
    const loaded = await loadRunBundle(reader);
    const session = loaded.sessions[current.bundleId];
    assert.ok(session);
    assert.deepEqual(session.binding, current);
    assert.equal(session.record.acpxRecordId, current.acpxRecordId);
    assert.equal(session.record.acpSessionId, current.acpSessionId);
    assert.equal(loaded.run.status, "completed");
    assert.deepEqual(loaded.run.sessionBindings[current.key], current);
    const historical = loaded.trace.filter((item) => item.type === "session_bound");
    assert.deepEqual(historical, [event]);

    const snapshot = await readBindingArtifact(fixture, historical[0]);
    assert.deepEqual(snapshot.binding, initial);
    assert.deepEqual(JSON.parse(await reader.readText(snapshot.reference.path)), initial);
    const entry = loaded.manifest.sessions.find((item) => item.id === current.bundleId);
    assert.ok(entry);
    assert.notEqual(entry.bindingPath, snapshot.reference.path);
    assert.deepEqual(JSON.parse(await reader.readText(entry.bindingPath)), current);
  });
});

test("binding publication snapshots caller input and nested argv before its first await", async () => {
  await withBindingFixture(async (fixture) => {
    const input = bindingFor(fixture, "admitted");
    const initial = structuredClone(input);
    // An async call runs to its first await synchronously. Mutating here happens
    // before ensureSessionBundle's initial mkdir continuation, without an fs stub.
    const publication = fixture.store.ensureSessionBundle(
      fixture.runDir,
      fixture.state,
      input,
      makeSessionRecord({
        acpxRecordId: initial.acpxRecordId,
        acpSessionId: initial.acpSessionId,
        agentCommand: initial.agentCommand,
        agentArgv: initial.agentArgv,
        cwd: initial.cwd,
        name: initial.name,
      }),
    );
    input.key = "changed::fixture";
    input.handle = "changed";
    input.bundleId = "changed-bundle";
    input.name = "changed-name";
    input.agentCommand = "changed-agent";
    input.acpxRecordId = "changed-record";
    input.acpSessionId = "changed-provider";
    assert.ok(input.agentArgv);
    input.agentArgv[0] = "changed-agent";
    input.agentArgv.push("--changed-after-invocation");
    await publication;

    const manifest = await manifestFor(fixture);
    assert.equal(manifest.sessions.length, 1);
    const entry = await entryFor(fixture, initial.bundleId);
    const projected = await readJson<FlowSessionBinding>(
      referencedFile(fixture.runDir, entry.bindingPath),
    );
    assert.deepEqual(projected, initial);
    assert.deepEqual(projected.agentArgv, ["synthetic-agent", "--fixture"]);
    const record = await readJson<{
      acpxRecordId: string;
      acpSessionId: string;
      agentArgv: string[];
      eventLog: { active_path: string };
    }>(referencedFile(fixture.runDir, entry.recordPath));
    assert.equal(record.acpxRecordId, initial.acpxRecordId);
    assert.equal(record.acpSessionId, initial.acpSessionId);
    assert.deepEqual(record.agentArgv, initial.agentArgv);
    assert.equal(record.eventLog.active_path, entry.eventsPath);
    const event = await onlyBoundEvent(fixture, initial.bundleId);
    const snapshot = await readBindingArtifact(fixture, event);
    assert.deepEqual(snapshot.binding, initial);
    assert.equal((await boundEvents(fixture)).length, 1);
    assert.equal(
      manifest.sessions.some((session) => session.id === input.bundleId),
      false,
    );
    assert.deepEqual(await bindingTraceEventTypes(fixture), ["run_started", "session_bound"]);
  });
});

test("an unusable real artifacts parent rejects before advertising a binding and permits retry", async () => {
  await withBindingFixture(async (fixture) => {
    const manifestPath = path.join(fixture.runDir, "manifest.json");
    const manifest = await manifestFor(fixture);
    assert.equal(manifest.sessions.length, 0);
    const tracePath = referencedFile(fixture.runDir, manifest.paths.trace);
    const manifestBefore = await fs.readFile(manifestPath);
    const traceBefore = await fs.readFile(tracePath);
    const artifactsParent = path.join(fixture.runDir, "artifacts");
    assert.deepEqual(await fs.readdir(artifactsParent), []);
    await fs.rmdir(artifactsParent);
    await fs.writeFile(artifactsParent, "synthetic regular-file blocker");
    const binding = bindingFor(fixture, "refused");

    const publications = [publishBinding(fixture, binding), publishBinding(fixture, binding)];
    await Promise.all(
      publications.map((publication) =>
        assert.rejects(publication, (error: unknown) => {
          assert.ok(error instanceof Error);
          const code = (error as NodeJS.ErrnoException).code;
          assert.ok(
            code === "EEXIST" || code === "ENOTDIR",
            `unexpected publication error: ${String(error)}`,
          );
          return true;
        }),
      ),
    );
    assert.deepEqual(await fs.readFile(manifestPath), manifestBefore);
    assert.deepEqual(await fs.readFile(tracePath), traceBefore);
    assert.equal((await manifestFor(fixture)).sessions.length, 0);
    assert.deepEqual(await boundEvents(fixture), []);

    // The same store still has no advertised/cached session entry after refusal.
    await fs.unlink(artifactsParent);
    await publishBinding(fixture, binding);
    const event = await onlyBoundEvent(fixture, binding.bundleId);
    assert.deepEqual((await readBindingArtifact(fixture, event)).binding, binding);
    assert.equal((await manifestFor(fixture)).sessions.length, 1);
    assert.deepEqual(await bindingTraceEventTypes(fixture), ["run_started", "session_bound"]);
  });
});

test("concurrent bindings retain the first snapshot and publish later metadata in order", async (t) => {
  await withBindingFixture(async (fixture) => {
    const binding = bindingFor(fixture, "concurrent");
    const current = {
      ...binding,
      acpSessionId: "resumed-provider",
      agentSessionId: "resumed-agent",
    };
    const written = createDeferred<void>();
    const release = createDeferred<void>();
    const writeArtifact = fixture.store.writeArtifact.bind(fixture.store);
    let first = true;
    t.mock.method(
      fixture.store,
      "writeArtifact",
      async (...args: Parameters<FlowRunStore["writeArtifact"]>) => {
        const hold = first;
        first = false;
        const artifact = await writeArtifact(...args);
        if (hold) {
          written.resolve();
          await release.promise;
        }
        return artifact;
      },
    );

    const pending = publishBinding(fixture, binding);
    let later: Promise<void> | undefined;
    let completedBeforeRelease = false;
    try {
      await written.promise;
      later = publishBinding(fixture, current);
      completedBeforeRelease = await Promise.race([
        later.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
    } finally {
      release.resolve();
      await Promise.all([pending, later]);
    }

    assert.equal(
      completedBeforeRelease,
      false,
      "later metadata must wait for the initial snapshot",
    );
    assert.equal((await manifestFor(fixture)).sessions.length, 1);
    const event = await onlyBoundEvent(fixture, binding.bundleId);
    assert.deepEqual((await readBindingArtifact(fixture, event)).binding, binding);
    const entry = await entryFor(fixture, binding.bundleId);
    assert.deepEqual(
      await readJson<FlowSessionBinding>(referencedFile(fixture.runDir, entry.bindingPath)),
      current,
    );
  });
});

async function bindingTraceEventTypes(fixture: BindingFixture): Promise<string[]> {
  const manifest = await manifestFor(fixture);
  return (await fs.readFile(referencedFile(fixture.runDir, manifest.paths.trace), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as FlowTraceEvent).type);
}
