import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { withTimeout } from "../src/async-control.js";
import { listSessionEvents } from "../src/session/events.js";
import { ensureSession } from "../src/session/execution/session-management.js";
import { exportSession } from "../src/session/export.js";
import { importSession } from "../src/session/import.js";
import { listSessions } from "../src/session/persistence.js";
import { acquireSessionImport } from "../src/session/turn-ownership.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const history = ["first", "second", "third"].map((text) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { text: `import-publication-${text}` },
}));

function historyPath(home: string, recordId: string): string {
  return path.join(home, ".acpx", "sessions", `${encodeURIComponent(recordId)}.stream.ndjson`);
}

async function importFixture(
  home: string,
  options: { tag?: string; provider?: string; command?: string } = {},
) {
  const tag = options.tag ?? "source";
  const entries =
    tag === "source"
      ? history
      : history.map((entry) => ({
          ...entry,
          params: { text: `${entry.params.text}-${tag}` },
        }));
  const source = makeSessionRecord({
    acpxRecordId: `import-${tag}`,
    acpSessionId: options.provider ?? "import-provider",
    agentCommand: options.command ?? "synthetic-import-agent",
    cwd: home,
    name: "import-target",
  });
  await writeSessionRecordFile(home, source);
  await fs.writeFile(
    historyPath(home, source.acpxRecordId),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const archive = path.join(home, `archive-${tag}.json`);
  await exportSession({ agentCommand: source.agentCommand, cwd: home, name: source.name }, archive);
  await fs.unlink(sessionFilePath(home, source.acpxRecordId));
  await fs.unlink(historyPath(home, source.acpxRecordId));
  const directory = await fs.realpath(path.join(home, ".acpx", "sessions"));
  return { archive, directory, source, history: entries };
}

function finalRecord(target: string, directory: string): boolean {
  return path.dirname(target) === directory && target.endsWith(".json");
}

function ioFailure(): NodeJS.ErrnoException {
  return Object.assign(new Error("synthetic import publication failure"), { code: "EIO" });
}

test("failed imported-history publication leaves no discoverable session and permits retry", async (t) => {
  await withTempHome("acpx-import-publication-", async (home) => {
    const { archive, directory, source } = await importFixture(home);
    const sentinel = makeSessionRecord({
      acpxRecordId: "unrelated-record",
      acpSessionId: "unrelated-provider",
      agentCommand: "unrelated-agent",
      cwd: home,
      name: "unrelated",
    });
    await writeSessionRecordFile(home, sentinel);
    const sentinelHistory = "unrelated history must remain byte-identical\n";
    await fs.writeFile(historyPath(home, sentinel.acpxRecordId), sentinelHistory);
    const sentinelRecord = await fs.readFile(sessionFilePath(home, sentinel.acpxRecordId));
    const rename = fs.rename;
    const failure = ioFailure();
    let faulted = false;
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      const target = String(args[1]);
      if (path.dirname(target) === directory && target.endsWith(".stream.ndjson")) {
        faulted = true;
        throw failure;
      }
      return await rename(...args);
    });
    await assert.rejects(importSession(archive), (error: unknown) => error === failure);
    mocked.mock.restore();
    assert.equal(faulted, true);
    assert.deepEqual(
      (await listSessions()).map((record) => record.acpxRecordId),
      [sentinel.acpxRecordId],
    );
    assert.deepEqual(
      await fs.readFile(sessionFilePath(home, sentinel.acpxRecordId)),
      sentinelRecord,
    );
    assert.equal(
      await fs.readFile(historyPath(home, sentinel.acpxRecordId), "utf8"),
      sentinelHistory,
    );
    const imported = await importSession(archive);
    const record = (await listSessions()).find(
      (entry) => entry.acpxRecordId === imported.record_id,
    );
    assert.equal(record?.acpSessionId, source.acpSessionId);
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
  });
});

test("complete imported history exists before the canonical record can be discovered", async (t) => {
  await withTempHome("acpx-import-visibility-", async (home) => {
    const { archive, directory } = await importFixture(home);
    const rename = fs.rename;
    let recordTarget = "";
    let announce!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      const target = String(args[1]);
      if (finalRecord(target, directory)) {
        recordTarget = target;
        announce();
        await released;
      }
      return await rename(...args);
    });
    const importing = importSession(archive);
    try {
      await Promise.race([
        reached,
        importing.then(() => {
          throw new Error("Import bypassed the record-publication gate");
        }),
      ]);
      assert.deepEqual(await listSessions(), []);
      const recordId = decodeURIComponent(path.basename(recordTarget, ".json"));
      const payload = await fs.readFile(historyPath(home, recordId), "utf8");
      assert.deepEqual(
        payload
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
        history,
      );
    } finally {
      release();
      await importing;
      mocked.mock.restore();
    }
    const imported = await importing;
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
    assert.equal((await listSessions()).length, 1);
  });
});

test("failed record publication does not claim the import scope or provider", async (t) => {
  await withTempHome("acpx-import-record-failure-", async (home) => {
    const { archive, directory } = await importFixture(home);
    const rename = fs.rename;
    const failure = ioFailure();
    let faulted = false;
    const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      if (finalRecord(String(args[1]), directory)) {
        faulted = true;
        throw failure;
      }
      return await rename(...args);
    });
    await assert.rejects(importSession(archive), (error: unknown) => error === failure);
    mocked.mock.restore();
    assert.equal(faulted, true);
    assert.deepEqual(await listSessions(), []);
    const imported = await importSession(archive);
    assert.deepEqual(await listSessionEvents(imported.record_id), history);
    assert.equal((await listSessions()).length, 1);
  });
});

test("import admission preserves legacy and MIME-tagged image payloads through re-export", async () => {
  await withTempHome("acpx-import-images-", async (home) => {
    const source = makeSessionRecord({
      acpxRecordId: "image-import-source",
      acpSessionId: "image-import-provider",
      agentCommand: "synthetic-image-agent",
      cwd: home,
      name: "image-target",
      messages: [
        {
          User: {
            id: "image-prompt",
            content: [
              { Image: { source: "bGVnYWN5LWltYWdl", size: null } },
              { Image: { source: "dHlwZWQtaW1hZ2U=", mime_type: "image/png", size: null } },
            ],
          },
        },
      ],
    });
    await writeSessionRecordFile(home, source);
    const archive = path.join(home, "images.json");
    const selection = { agentCommand: source.agentCommand, cwd: home, name: source.name };
    await exportSession(selection, archive);
    await fs.unlink(sessionFilePath(home, source.acpxRecordId));

    const imported = await importSession(archive);
    const records = await listSessions();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.acpxRecordId, imported.record_id);
    assert.deepEqual(records[0]?.messages, source.messages);
    const reexport = path.join(home, "images-reexported.json");
    await exportSession(selection, reexport);
    const original = JSON.parse(await fs.readFile(archive, "utf8")) as {
      session: { state: { messages: unknown } };
    };
    const restored = JSON.parse(await fs.readFile(reexport, "utf8")) as typeof original;
    assert.deepEqual(restored.session.state.messages, original.session.state.messages);
  });
});

function admissionGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ImportResult = Awaited<ReturnType<typeof importSession>>;

async function overlapImports(
  t: TestContext,
  directory: string,
  firstCall: () => Promise<ImportResult>,
  secondCall: () => Promise<ImportResult>,
  publicationFailure?: Error,
): Promise<[PromiseSettledResult<ImportResult>, PromiseSettledResult<ImportResult>]> {
  const atCommit = admissionGate();
  const release = admissionGate();
  const secondAtIo = admissionGate();
  const rename = fs.rename;
  let firstTarget: string | undefined;
  const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
    const target = String(args[1]);
    if (!firstTarget && finalRecord(target, directory)) {
      firstTarget = target;
      atCommit.resolve();
      await release.promise;
      if (publicationFailure) {
        throw publicationFailure;
      }
    }
    return await rename(...args);
  });
  const first = firstCall();
  void first.catch(() => {});
  let second: Promise<ImportResult> | undefined;
  let restoreObservation: (() => void) | undefined;
  try {
    await withTimeout(
      Promise.race([
        atCommit.promise,
        first.then(() => {
          throw new Error("First import bypassed final record rename");
        }),
      ]),
      5_000,
    );
    assert.deepEqual(await listSessions(), []);

    // A is stationary at its actual commit. On the candidate B's first realpath
    // is owner routing; on the old implementation it is history publication,
    // after both scans. This is a scheduling receipt, not lock-contention proof.
    const realpath = fs.realpath;
    const observation = t.mock.method(
      fs,
      "realpath",
      async (...args: Parameters<typeof realpath>) => {
        const result = await realpath(...args);
        if (result === directory) {
          secondAtIo.resolve();
        }
        return result;
      },
    );
    restoreObservation = () => observation.mock.restore();
    second = secondCall();
    void second.catch(() => {});
    await withTimeout(
      Promise.race([
        secondAtIo.promise,
        second.then(() => {
          throw new Error("Second import bypassed the overlap receipt");
        }),
      ]),
      5_000,
    );
    release.resolve();
    return await Promise.allSettled([first, second]);
  } finally {
    release.resolve();
    // The watchdog never abandons an acquisition. Join both operations before
    // restoring mocks or allowing withTempHome to remove the store.
    await Promise.allSettled(second ? [first, second] : [first]);
    restoreObservation?.();
    renameMock.mock.restore();
  }
}

function assertImportConflict(error: unknown, code: string): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: unknown }).code, code);
  assert.equal((error as { detailCode?: unknown }).detailCode, code);
  assert.equal((error as { outputCode?: unknown }).outputCode, "USAGE");
  assert.equal((error as { exitCode?: unknown }).exitCode, 2);
  return true;
}

const concurrentImports = [
  {
    label: "identical archive and destination preserves scope-error precedence",
    sameProvider: true,
    sameCommand: true,
    sameScope: true,
    sameArchive: true,
    conflict: "session-scope-exists",
  },
  {
    label: "distinct providers collide in one normalized scope",
    sameProvider: false,
    sameCommand: true,
    sameScope: true,
    sameArchive: false,
    conflict: "session-scope-exists",
  },
  {
    label: "one provider collides across names and cwd",
    sameProvider: true,
    sameCommand: true,
    sameScope: false,
    sameArchive: false,
    conflict: "session-provider-exists",
  },
  {
    label: "one provider collides across effective commands and scopes",
    sameProvider: true,
    sameCommand: false,
    sameScope: false,
    sameArchive: false,
    conflict: "session-provider-exists",
  },
  {
    label: "independent valid imports both keep their exact histories",
    sameProvider: false,
    sameCommand: false,
    sameScope: false,
    sameArchive: false,
    conflict: undefined,
  },
] as const;

for (const scenario of concurrentImports) {
  test(`concurrent import admission: ${scenario.label}`, async (t) => {
    await withTempHome("acpx-import-admission-", async (home) => {
      const firstFixture = await importFixture(home);
      const secondFixture = scenario.sameArchive
        ? firstFixture
        : await importFixture(home, {
            tag: "second",
            provider: scenario.sameProvider ? "import-provider" : "second-provider",
            command: scenario.sameCommand ? "synthetic-import-agent" : "second-import-agent",
          });
      const cwd = path.join(home, "workspace");
      const [first, second] = await overlapImports(
        t,
        firstFixture.directory,
        () => importSession(firstFixture.archive, { newCwd: cwd }),
        () =>
          importSession(secondFixture.archive, {
            name: scenario.sameScope ? " import-target " : "second-target",
            newCwd: scenario.sameScope ? path.join(cwd, "child", "..") : path.join(home, "other"),
            expectedAgentCommand: secondFixture.source.agentCommand,
          }),
      );
      assert.equal(first.status, "fulfilled");
      assert.deepEqual(await listSessionEvents(first.value.record_id), firstFixture.history);
      const records = await listSessions();
      const winningRecord = records.find((entry) => entry.acpxRecordId === first.value.record_id);
      assert.equal(winningRecord?.acpSessionId, firstFixture.source.acpSessionId);
      assert.equal(winningRecord?.cwd, cwd);
      if (scenario.conflict) {
        assert.equal(second.status, "rejected");
        assertImportConflict(second.reason, scenario.conflict);
        assert.equal(records.length, 1);
      } else {
        assert.equal(second.status, "fulfilled");
        assert.notEqual(second.value.record_id, first.value.record_id);
        assert.equal(records.length, 2);
        const nextRecord = records.find((entry) => entry.acpxRecordId === second.value.record_id);
        assert.equal(nextRecord?.acpSessionId, secondFixture.source.acpSessionId);
        assert.equal(nextRecord?.agentCommand, secondFixture.source.agentCommand);
        assert.equal(nextRecord?.cwd, path.join(home, "other"));
        assert.equal(nextRecord?.name, "second-target");
        assert.deepEqual(await listSessionEvents(second.value.record_id), secondFixture.history);
      }
    });
  });
}

test("an import waiting behind failed record publication may claim the same scope and provider", async (t) => {
  await withTempHome("acpx-import-admission-failed-", async (home) => {
    const fixture = await importFixture(home);
    const failure = ioFailure();
    const [first, second] = await overlapImports(
      t,
      fixture.directory,
      () => importSession(fixture.archive),
      () => importSession(fixture.archive),
      failure,
    );
    assert.deepEqual(first, { status: "rejected", reason: failure });
    assert.equal(second.status, "fulfilled");
    const records = await listSessions();
    assert.deepEqual(
      records.map((record) => record.acpxRecordId),
      [second.value.record_id],
    );
    assert.equal(records[0]?.acpSessionId, fixture.source.acpSessionId);
    assert.deepEqual(await listSessionEvents(second.value.record_id), fixture.history);
    // PERSIST-08 permits A's complete, undiscoverable history to remain.
  });
});

test("closed records on another command still reserve their provider identity", async () => {
  await withTempHome("acpx-import-closed-provider-", async (home) => {
    const fixture = await importFixture(home);
    const existing = makeSessionRecord({
      acpxRecordId: "closed-existing",
      acpSessionId: fixture.source.acpSessionId,
      agentCommand: "other-command",
      cwd: path.join(home, "other"),
      name: "closed",
      closed: true,
      closedAt: "2026-01-02T00:00:00.000Z",
    });
    await writeSessionRecordFile(home, existing);
    await assert.rejects(importSession(fixture.archive), (error: unknown) =>
      assertImportConflict(error, "session-provider-exists"),
    );
    assert.deepEqual(
      (await listSessions()).map((record) => record.acpxRecordId),
      [existing.acpxRecordId],
    );
  });
});

for (const failBody of [false, true]) {
  test(`import disposal failure ${failBody ? "preserves the publication error" : "preserves committed data"}`, async (t) => {
    await withTempHome("acpx-import-disposal-", async (home) => {
      const fixture = await importFixture(home);
      const marker = path.join(fixture.directory, ".import-admission.lock");
      const primary = ioFailure();
      const cleanup = new Error("synthetic import marker cleanup failure");
      const unlink = fs.unlink;
      let markerFailures = 0;
      const unlinkMock = t.mock.method(fs, "unlink", async (...args: Parameters<typeof unlink>) => {
        if (String(args[0]) === marker && markerFailures++ === 0) {
          throw cleanup;
        }
        return await unlink(...args);
      });
      const rename = fs.rename;
      let commitTarget: string | undefined;
      const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
        if (finalRecord(String(args[1]), fixture.directory)) {
          commitTarget = String(args[1]);
          if (failBody) {
            throw primary;
          }
        }
        return await rename(...args);
      });
      let assertionFailed = false;
      let assertionFailure: unknown;
      try {
        await assert.rejects(importSession(fixture.archive), (error: unknown) => {
          if (!failBody) {
            return error === cleanup;
          }
          assert.ok(error instanceof Error);
          assert.equal(error.name, "SuppressedError");
          assert.equal((error as Error & { error?: unknown }).error, cleanup);
          assert.equal((error as Error & { suppressed?: unknown }).suppressed, primary);
          return true;
        });
        assert.equal(markerFailures, 1);
        assert.ok(commitTarget);
        await fs.access(marker);
        await fs.access(`${marker}.guard`);
        const attemptedId = decodeURIComponent(path.basename(commitTarget, ".json"));
        const retainedHistory = await fs.readFile(historyPath(home, attemptedId), "utf8");
        assert.equal(
          retainedHistory,
          fixture.history.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        );
        const records = await listSessions();
        assert.deepEqual(
          records.map((record) => record.acpxRecordId),
          failBody ? [] : [attemptedId],
        );
        const committedBytes = failBody ? undefined : await fs.readFile(commitTarget);
        unlinkMock.mock.restore();
        renameMock.mock.restore();
        if (failBody) {
          const retried = await importSession(fixture.archive);
          assert.notEqual(retried.record_id, attemptedId);
          assert.deepEqual(await listSessionEvents(retried.record_id), fixture.history);
          assert.equal((await listSessions()).length, 1);
        } else {
          // Exercise the next-acquisition retained-receipt path, not manual unlink.
          const recovered = await acquireSessionImport(AbortSignal.timeout(2_000));
          await recovered[Symbol.asyncDispose]();
          assert.deepEqual(await fs.readFile(commitTarget), committedBytes);
          assert.equal(await fs.readFile(historyPath(home, attemptedId), "utf8"), retainedHistory);
          await assert.rejects(importSession(fixture.archive), (error: unknown) =>
            assertImportConflict(error, "session-scope-exists"),
          );
        }
        await assert.rejects(fs.access(marker), { code: "ENOENT" });
        await assert.rejects(fs.access(`${marker}.guard`), { code: "ENOENT" });
      } catch (error) {
        assertionFailed = true;
        assertionFailure = error;
      }
      try {
        unlinkMock.mock.restore();
        renameMock.mock.restore();
        // Settle a retained receipt even when an assertion above failed.
        const ownership = await acquireSessionImport(AbortSignal.timeout(2_000));
        await ownership[Symbol.asyncDispose]();
      } catch (cleanupError) {
        if (assertionFailed) {
          throw new AggregateError(
            [assertionFailure, cleanupError],
            "Import disposal regression and receipt cleanup both failed",
            { cause: cleanupError },
          );
        }
        throw cleanupError;
      }
      if (assertionFailed) {
        throw assertionFailure;
      }
    });
  });
}

function ensureFixtureAgent(home: string) {
  const pidFile = path.join(home, "ensure-agent.pid");
  const invocation = normalizeAgentCommandInput([
    process.execPath,
    fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
    "--pid-file",
    pidFile,
  ]);
  return { ...invocation, pidFile };
}

for (const normalized of [false, true]) {
  test(`ensure selects the concurrently imported record (normalized=${normalized})`, async (t) => {
    await withTempHome("acpx-ensure-import-", async (home) => {
      const agent = ensureFixtureAgent(home);
      const fixture = await importFixture(home, { command: agent.agentCommand });
      const atCommit = admissionGate();
      const releaseCommit = admissionGate();
      const emptySnapshot = admissionGate();
      const ensureRouted = admissionGate();
      const rename = fs.rename;
      let held = false;
      const renameMock = t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
        if (!held && finalRecord(String(args[1]), fixture.directory)) {
          held = true;
          atCommit.resolve();
          await releaseCommit.promise;
        }
        return await rename(...args);
      });
      const importing = importSession(fixture.archive);
      void importing.catch(() => {});
      let ensuring: ReturnType<typeof ensureSession> | undefined;
      let restoreObservation: (() => void) | undefined;
      let restoreRouting: (() => void) | undefined;
      try {
        await withTimeout(
          Promise.race([
            atCommit.promise,
            importing.then(() => {
              throw new Error("Import bypassed the final canonical-record gate");
            }),
          ]),
          5_000,
        );
        // This is the existing mixed-version ensure marker contract, not a
        // new test-only owner. Both implementations hold A at its real commit.
        // Baseline permits B's empty discovery snapshot; the candidate prevents
        // B from reaching that snapshot, so use its scope-routing receipt there.
        // Routing is not proof of actual contention; native proof supplies that.
        const key = createHash("sha256")
          .update(JSON.stringify([agent.agentCommand, home, "import-target"]))
          .digest("hex");
        const scopePath = path.join(
          fixture.directory,
          `${encodeURIComponent(`ensure:${key}`)}.stream.lock`,
        );
        const ownsScope = await fs.stat(scopePath).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return false;
            }
            throw error;
          },
        );
        const realpath = fs.realpath;
        const routing = t.mock.method(
          fs,
          "realpath",
          async (...args: Parameters<typeof realpath>) => {
            const result = await realpath(...args);
            if (result === fixture.directory) {
              ensureRouted.resolve();
            }
            return result;
          },
        );
        restoreRouting = () => routing.mock.restore();
        const readdir = fs.readdir;
        const observation = t.mock.method(
          fs,
          "readdir",
          async (...args: Parameters<typeof readdir>) => {
            // The actual directory result is returned unchanged. This receipt
            // binds ensure's first snapshot to the pre-import state; no sleep
            // or inferred process start is used to claim an empty lookup.
            const result = await readdir(...args);
            if (
              [fixture.directory, path.join(home, ".acpx", "sessions")].includes(
                path.resolve(String(args[0])),
              )
            ) {
              const names = result.map((entry) =>
                typeof entry === "string"
                  ? entry
                  : Buffer.isBuffer(entry)
                    ? entry.toString("utf8")
                    : entry.name.toString(),
              );
              if (!names.some((name) => name.endsWith(".json") && name !== "index.json")) {
                emptySnapshot.resolve();
              }
            }
            return result;
          },
        );
        restoreObservation = () => observation.mock.restore();
        ensuring = ensureSession({
          agentCommand: agent.agentCommand,
          agentArgv: agent.agentArgv,
          cwd: normalized ? `${home}${path.sep}child${path.sep}..` : home,
          name: normalized ? " import-target " : "import-target",
          walkBoundary: home,
          permissionMode: "deny-all",
          handleProcessInterrupts: false,
          timeoutMs: 2_000,
        });
        void ensuring.catch(() => {});
        await withTimeout(
          Promise.race([
            ownsScope ? ensureRouted.promise : emptySnapshot.promise,
            ensuring.then(() => {
              throw new Error("Ensure bypassed its scheduled overlap receipt");
            }),
          ]),
          5_000,
        );
        releaseCommit.resolve();
        const [imported, ensured] = await Promise.all([importing, ensuring]);
        assert.equal(ensured.created, false);
        assert.equal(ensured.record.acpxRecordId, imported.record_id);
        assert.equal(ensured.record.acpSessionId, fixture.source.acpSessionId);
        assert.deepEqual(
          (await listSessions()).map((record) => record.acpxRecordId),
          [imported.record_id],
        );
        assert.deepEqual(await listSessionEvents(imported.record_id), fixture.history);
        await assert.rejects(fs.stat(agent.pidFile), { code: "ENOENT" });
      } finally {
        releaseCommit.resolve();
        await Promise.allSettled(ensuring ? [importing, ensuring] : [importing]);
        restoreRouting?.();
        restoreObservation?.();
        renameMock.mock.restore();
      }
    });
  });
}

test("ensure of an existing session does not wait behind unrelated import admission", async () => {
  await withTempHome("acpx-ensure-import-existing-", async (home) => {
    const agent = ensureFixtureAgent(home);
    const fixture = await importFixture(home, { command: agent.agentCommand });
    const imported = await importSession(fixture.archive);
    await using admission = await acquireSessionImport();
    void admission;
    const ensured = await ensureSession({
      agentCommand: agent.agentCommand,
      agentArgv: agent.agentArgv,
      cwd: home,
      name: "import-target",
      walkBoundary: home,
      permissionMode: "deny-all",
      handleProcessInterrupts: false,
      signal: AbortSignal.timeout(2_000),
      timeoutMs: 2_000,
    });
    assert.equal(ensured.created, false);
    assert.equal(ensured.record.acpxRecordId, imported.record_id);
    await assert.rejects(fs.stat(agent.pidFile), { code: "ENOENT" });
  });
});

test("failed native ensure releases its scope without blocking import", async () => {
  await withTempHome("acpx-ensure-import-failure-", async (home) => {
    const agent = normalizeAgentCommandInput([process.execPath, "-e", "process.exit(23)"]);
    const fixture = await importFixture(home, { command: agent.agentCommand });
    await assert.rejects(
      ensureSession({
        ...agent,
        cwd: home,
        name: "import-target",
        walkBoundary: home,
        permissionMode: "deny-all",
        handleProcessInterrupts: false,
        timeoutMs: 2_000,
      }),
    );
    assert.deepEqual(await listSessions(), []);
    const imported = await importSession(fixture.archive);
    assert.deepEqual(
      (await listSessions()).map((record) => record.acpxRecordId),
      [imported.record_id],
    );
    assert.deepEqual(await listSessionEvents(imported.record_id), fixture.history);
  });
});
