import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as captureNextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { InterruptedError, TimeoutError } from "../src/async-control.js";
import { AgentDisconnectedError } from "../src/errors.js";
import { FlowRunner, acp, compute, defineFlow } from "../src/flows/runtime.js";
import type { FlowRunStore } from "../src/flows/store.js";
import type {
  FlowArtifactRef,
  FlowBundledSessionEvent,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  FlowTraceEvent,
} from "../src/flows/types.js";
import type { SessionRecord } from "../src/types.js";
import { withTempHome } from "./runtime-test-helpers.js";

const PEER = fileURLToPath(new URL("./fixtures/flow-failed-capture-peer.js", import.meta.url));
type WireMessage = {
  id?: string | number;
  method?: string;
  params?: { sessionId?: string; prompt?: Array<{ type?: string; text?: string }> };
  result?: { sessionId?: string; stopReason?: string };
  error?: { code: number; message: string };
};
type PeerReceipt = {
  kind: "started" | "received" | "sent" | "disconnect";
  pid: number;
  message?: WireMessage;
  sessionId?: string;
  marker?: string;
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function readLines<T>(file: string): Promise<T[]> {
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function bundlePath(runDir: string, reference: string): string {
  assert.equal(path.isAbsolute(reference), false, "bundle references must be relative");
  const resolved = path.resolve(runDir, ...reference.split("/"));
  const relative = path.relative(runDir, resolved);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes(".."));
  return resolved;
}

async function readArtifact(
  runDir: string,
  artifact: FlowArtifactRef | undefined,
): Promise<string> {
  assert.ok(artifact, "the attempt must link its actual artifact");
  const bytes = await fs.readFile(bundlePath(runDir, artifact.path));
  assert.equal(artifact.mediaType, "text/plain");
  assert.equal(artifact.bytes, bytes.byteLength);
  assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  return bytes.toString("utf8");
}

async function loadBundle(outputRoot: string) {
  const directories = (await fs.readdir(outputRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  assert.equal(directories.length, 1, "the fixture performs exactly one run");
  const runDir = path.join(outputRoot, directories[0].name);
  const manifest = await readJson<FlowRunManifest>(path.join(runDir, "manifest.json"));
  assert.equal(manifest.sessions.length, 1, "both persistent turns must share one bundle");
  const session = manifest.sessions[0];
  const [state, steps, trace, binding, record, events] = await Promise.all([
    readJson<FlowRunState>(bundlePath(runDir, manifest.paths.runProjection)),
    readJson<FlowStepRecord[]>(bundlePath(runDir, manifest.paths.stepsProjection)),
    readLines<FlowTraceEvent>(bundlePath(runDir, manifest.paths.trace)),
    readJson<FlowSessionBinding>(bundlePath(runDir, session.bindingPath)),
    readJson<SessionRecord>(bundlePath(runDir, session.recordPath)),
    readLines<FlowBundledSessionEvent>(bundlePath(runDir, session.eventsPath)),
  ]);
  assert.deepEqual(state.steps, steps);
  assert.equal(manifest.status, state.status);
  assert.equal(binding.bundleId, session.id);
  assert.equal(record.acpxRecordId, binding.acpxRecordId);
  assert.equal(record.acpSessionId, binding.acpSessionId);
  assert.equal(record.eventLog.active_path, session.eventsPath);
  assert.ok(events.length > 0);
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.equal(record.lastSeq, events.at(-1)?.seq);
  return { runDir, manifest, session, state, steps, trace, binding, record, events };
}

type Bundle = Awaited<ReturnType<typeof loadBundle>>;

function messagesOf(bundle: Bundle, step: FlowStepRecord): string {
  const range = step.trace?.conversation;
  assert.ok(range, "the attempt must link normalized and wire ranges");
  assert.equal(range.sessionId, bundle.session.id);
  assert.ok(Number.isInteger(range.messageStart) && range.messageStart >= 0);
  assert.ok(Number.isInteger(range.messageEnd) && range.messageEnd >= range.messageStart);
  assert.ok(range.messageEnd < bundle.record.messages.length);
  return JSON.stringify(bundle.record.messages.slice(range.messageStart, range.messageEnd + 1));
}

function eventsOf(bundle: Bundle, step: FlowStepRecord): FlowBundledSessionEvent[] {
  const range = step.trace?.conversation;
  assert.ok(range);
  assert.ok(Number.isInteger(range.eventStartSeq) && range.eventStartSeq > 0);
  assert.ok(Number.isInteger(range.eventEndSeq) && range.eventEndSeq >= range.eventStartSeq);
  const selected = bundle.events.filter(
    (event) => event.seq >= range.eventStartSeq && event.seq <= range.eventEndSeq,
  );
  assert.equal(selected[0]?.seq, range.eventStartSeq);
  assert.equal(selected.at(-1)?.seq, range.eventEndSeq);
  return selected;
}

async function assertAttempt(
  bundle: Bundle,
  nodeId: string,
  prompt: string,
  marker: string,
  outcome: "ok" | "failed",
): Promise<FlowStepRecord> {
  const steps = bundle.steps.filter((step) => step.nodeId === nodeId);
  assert.equal(steps.length, 1);
  const step = steps[0];
  assert.equal(step.attemptId, `${nodeId}#1`);
  assert.equal(step.outcome, outcome);
  assert.equal(bundle.state.results[nodeId]?.outcome, outcome);
  assert.equal(step.promptText, prompt);
  assert.equal(step.rawText, `DIAGNOSTIC_${marker}`);
  assert.ok(step.session);
  assert.ok(step.agent);
  assert.equal(step.session.bundleId, bundle.session.id);
  assert.equal(step.session.acpxRecordId, bundle.binding.acpxRecordId);
  assert.equal(step.session.acpSessionId, bundle.binding.acpSessionId);
  assert.equal(step.agent.agentName, "capture-fixture");
  assert.equal(step.agent.cwd, bundle.binding.cwd);
  assert.equal(step.trace?.sessionId, bundle.session.id);
  assert.equal(await readArtifact(bundle.runDir, step.trace?.promptArtifact), prompt);
  assert.equal(
    await readArtifact(bundle.runDir, step.trace?.rawResponseArtifact),
    `DIAGNOSTIC_${marker}`,
  );

  const messages = messagesOf(bundle, step);
  assert.ok(messages.includes(prompt), "the normalized slice must contain this prompt");
  assert.ok(
    messages.includes(`DIAGNOSTIC_${marker}`),
    "the normalized slice must contain its answer",
  );
  const events = eventsOf(bundle, step);
  assert.ok(
    events.some((event) => {
      const message = event.message as WireMessage;
      return (
        event.direction === "outbound" &&
        message.method === "session/prompt" &&
        message.params?.sessionId === bundle.binding.acpSessionId &&
        message.params.prompt?.some((block) => block.type === "text" && block.text === prompt)
      );
    }),
    "the event range must include this actual prompt request",
  );
  assert.ok(
    events.some(
      (event) =>
        event.direction === "inbound" &&
        JSON.stringify(event.message).includes(`DIAGNOSTIC_${marker}`),
    ),
    "the event range must include this actual diagnostic notification",
  );
  const terminal = bundle.trace.filter(
    (event) => event.type === "node_outcome" && event.attemptId === step.attemptId,
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.outcome, outcome);
  assert.equal(terminal[0].payload.sessionId, bundle.session.id);
  assert.deepEqual(terminal[0].payload.conversation, step.trace?.conversation);
  assert.deepEqual(terminal[0].payload.promptArtifact, step.trace?.promptArtifact);
  assert.deepEqual(terminal[0].payload.rawResponseArtifact, step.trace?.rawResponseArtifact);
  return step;
}

function requests(receipts: PeerReceipt[], method: string): PeerReceipt[] {
  return receipts.filter((entry) => entry.kind === "received" && entry.message?.method === method);
}

function assertPeerIdentity(
  bundle: Bundle,
  receipts: PeerReceipt[],
  expectedPrompts: number,
): void {
  const creations = requests(receipts, "session/new");
  assert.equal(
    creations.length,
    1,
    "a failed persistent turn must not create a replacement session",
  );
  const creation = creations[0];
  const response = receipts.find(
    (entry) =>
      entry.kind === "sent" &&
      entry.pid === creation.pid &&
      entry.message?.id === creation.message?.id,
  );
  assert.equal(response?.message?.result?.sessionId, bundle.binding.acpSessionId);
  assert.match(bundle.binding.acpSessionId, /^capture-provider-/u);
  assert.equal(requests(receipts, "session/prompt").length, expectedPrompts);
  for (const entry of [
    ...requests(receipts, "session/prompt"),
    ...requests(receipts, "session/load"),
  ]) {
    assert.equal(entry.message?.params?.sessionId, bundle.binding.acpSessionId);
  }
  const launches = receipts.filter((entry) => entry.kind === "started");
  assert.ok(launches.length > 0);
  for (const { pid } of launches) {
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      `fixture peer ${pid} survived settlement`,
    );
  }
}

async function fixture(home: string) {
  const cwd = path.join(home, "workspace");
  const outputRoot = path.join(home, "runs");
  const receiptPath = path.join(home, "peer.jsonl");
  await fs.mkdir(cwd);
  await fs.writeFile(receiptPath, "");
  const runner = new FlowRunner({
    resolveAgent: () => ({
      agentName: "capture-fixture",
      agentCommand: "capture-fixture-display-name",
      agentArgv: [process.execPath, PEER, receiptPath, path.join(home, "peer-session.json")],
      cwd,
    }),
    permissionMode: "deny-all",
    defaultNodeTimeoutMs: 10_000,
    outputRoot,
  });
  return { runner, outputRoot, receipts: () => readLines<PeerReceipt>(receiptPath) };
}

for (const isolated of [true, false]) {
  for (const mode of ["rpc-error", "disconnect"] as const) {
    test(
      `failed ${isolated ? "isolated" : "persistent"} ACP ${mode} retains its own capture`,
      { timeout: 45_000 },
      async () => {
        await withTempHome("acpx-flow-failed-capture-", async (home) => {
          const peer = await fixture(home);
          const parseCalls: string[] = [];
          const failingPrompt = `${mode}:failed-turn`;
          const node = (prompt: string) =>
            acp({
              session: isolated ? { isolated: true } : { handle: "same-session" },
              prompt: () => prompt,
              parse: (text) => {
                parseCalls.push(text);
                return text;
              },
            });
          const flow = defineFlow({
            name: `capture-${isolated ? "isolated" : "persistent"}-${mode}`,
            startAt: isolated ? "failing" : "first",
            nodes: isolated
              ? { failing: node(failingPrompt) }
              : { first: node("success:first-turn"), failing: node(failingPrompt) },
            edges: isolated ? [] : [{ from: "first", to: "failing" }],
          });
          await assert.rejects(peer.runner.run(flow, {}), (error: unknown) => {
            if (mode === "rpc-error") {
              assert.ok(error instanceof Error);
              assert.match(error.message, /SYNTHETIC_FAILURE_failed-turn/u);
            } else {
              assert.ok(
                error instanceof AgentDisconnectedError,
                `expected the transport failure, got ${String(error)}`,
              );
            }
            return true;
          });
          const bundle = await loadBundle(peer.outputRoot);
          assert.equal(bundle.state.status, "failed");
          assert.equal(bundle.steps.length, isolated ? 1 : 2);
          assert.equal(bundle.trace.filter((event) => event.type === "run_failed").length, 1);
          const failed = await assertAttempt(
            bundle,
            "failing",
            failingPrompt,
            "failed-turn",
            "failed",
          );
          if (mode === "rpc-error") {
            assert.match(failed.error ?? "", /SYNTHETIC_FAILURE_failed-turn/u);
            assert.ok(
              eventsOf(bundle, failed).some(
                (event) =>
                  event.direction === "inbound" &&
                  (event.message as WireMessage).error?.code === -32077 &&
                  (event.message as WireMessage).error?.message === "SYNTHETIC_FAILURE_failed-turn",
              ),
            );
          }
          assert.deepEqual(parseCalls, isolated ? [] : ["DIAGNOSTIC_first-turn"]);
          if (!isolated) {
            const first = await assertAttempt(
              bundle,
              "first",
              "success:first-turn",
              "first-turn",
              "ok",
            );
            assert.ok(first.trace?.conversation && failed.trace?.conversation);
            assert.ok(failed.trace.conversation.messageStart > first.trace.conversation.messageEnd);
            assert.ok(
              failed.trace.conversation.eventStartSeq > first.trace.conversation.eventEndSeq,
            );
            assert.ok(!messagesOf(bundle, failed).includes("DIAGNOSTIC_first-turn"));
            assert.ok(!messagesOf(bundle, first).includes("DIAGNOSTIC_failed-turn"));
          }
          const receipts = await peer.receipts();
          assertPeerIdentity(bundle, receipts, isolated ? 1 : 2);
          if (mode === "disconnect") {
            assert.equal(
              receipts.filter(
                (entry) => entry.kind === "disconnect" && entry.marker === "failed-turn",
              ).length,
              1,
            );
          }
        });
      },
    );
  }

  // Separate control: the isolated provisional-ID mismatch is supplemental to FL4.
  test(
    `successful ${isolated ? "isolated" : "persistent"} ACP step agrees with its real session and bundle`,
    { timeout: 45_000 },
    async () => {
      await withTempHome("acpx-flow-capture-success-", async (home) => {
        const peer = await fixture(home);
        const result = await peer.runner.run(
          defineFlow({
            name: `capture-success-${isolated ? "isolated" : "persistent"}`,
            startAt: "only",
            nodes: {
              only: acp({
                session: isolated ? { isolated: true } : { handle: "same-session" },
                prompt: () => "success:ordinary-turn",
                parse: (text) => text,
              }),
            },
            edges: [],
          }),
          {},
        );
        const bundle = await loadBundle(peer.outputRoot);
        assert.equal(bundle.runDir, result.runDir);
        assert.equal(bundle.state.status, "completed");
        assert.equal(bundle.steps.length, 1);
        assert.equal(bundle.state.outputs.only, "DIAGNOSTIC_ordinary-turn");
        await assertAttempt(bundle, "only", "success:ordinary-turn", "ordinary-turn", "ok");
        assertPeerIdentity(bundle, await peer.receipts(), 1);
      });
    },
  );
}

const parserRejections: Array<{ name: string; create: () => unknown }> = [
  {
    name: "frozen Error",
    create: () => Object.freeze(new Error("SYNTHETIC_PARSER_FAILURE")),
  },
  { name: "undefined", create: () => undefined },
  { name: "null", create: () => null },
  { name: "false", create: () => false },
  { name: "string", create: () => "SYNTHETIC_PARSER_FAILURE" },
];

for (const isolated of [true, false]) {
  for (const rejected of parserRejections) {
    test(
      `${isolated ? "isolated" : "persistent"} ACP parser retains ${rejected.name} rejection and capture`,
      { timeout: 45_000 },
      async () => {
        await withTempHome("acpx-flow-parser-capture-", async (home) => {
          const peer = await fixture(home);
          const reason = rejected.create();
          let parseCalls = 0;
          const flow = defineFlow({
            name: "capture-parser-failure",
            startAt: "parse",
            nodes: {
              parse: acp({
                session: isolated ? { isolated: true } : { handle: "same-session" },
                prompt: () => "success:parser-turn",
                parse: (text) => {
                  parseCalls += 1;
                  assert.equal(text, "DIAGNOSTIC_parser-turn");
                  throw reason;
                },
              }),
            },
            edges: [],
          });

          // The predicate observes even an undefined rejection. A catch that
          // returns its value would confuse that rejection with success.
          await assert.rejects(peer.runner.run(flow, {}), (actual: unknown) => {
            assert.equal(actual, reason);
            return true;
          });
          assert.equal(parseCalls, 1);

          const bundle = await loadBundle(peer.outputRoot);
          assert.equal(bundle.state.status, "failed");
          assert.equal(bundle.steps.length, 1);
          assert.deepEqual(bundle.state.outputs, {});
          const step = await assertAttempt(
            bundle,
            "parse",
            "success:parser-turn",
            "parser-turn",
            "failed",
          );
          const expectedError = reason instanceof Error ? reason.message : String(reason);
          assert.equal(step.error, expectedError);
          assert.equal(bundle.state.error, expectedError);
          assert.equal(bundle.trace.filter((event) => event.type === "run_failed").length, 1);

          const events = eventsOf(bundle, step);
          const prompt = events.find(
            (event) =>
              event.direction === "outbound" &&
              (event.message as WireMessage).method === "session/prompt",
          );
          assert.ok(prompt, "the peer must have received an actual ACP prompt");
          const promptId = (prompt.message as WireMessage).id;
          assert.notEqual(promptId, undefined);
          assert.ok(
            events.some((event) => {
              const message = event.message as WireMessage;
              return (
                event.direction === "inbound" &&
                message.id === promptId &&
                message.result?.stopReason === "end_turn"
              );
            }),
            "this failure must follow a successful ACP reply, not a failing fixture",
          );
          assert.equal(
            events.some((event) => (event.message as WireMessage).error !== undefined),
            false,
          );
          assertPeerIdentity(bundle, await peer.receipts(), 1);
        });
      },
    );
  }
}

// Keep test watchdogs real when the timeout cases advance the attempt's clock.
const captureRealSetTimeout = globalThis.setTimeout;
const captureRealClearTimeout = globalThis.clearTimeout;

function captureDeferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function captureWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = captureRealSetTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      captureRealClearTimeout(timer);
    }
  }
}

function observeCaptureRun<T>(promise: Promise<T>, onSettled: () => void) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      onSettled();
      return { status: "fulfilled" as const, value };
    },
    (reason: unknown) => {
      settled = true;
      onSettled();
      return { status: "rejected" as const, reason };
    },
  );
  return { outcome, settled: () => settled };
}

type CaptureWriteBoundary = "event" | "record" | "raw";

function holdCapturePublication(
  t: TestContext,
  runner: FlowRunner,
  boundary: CaptureWriteBoundary,
  marker: string,
  failure?: Error,
) {
  const store = (runner as unknown as { store: FlowRunStore }).store;
  const entered = captureDeferred();
  const released = captureDeferred();
  const originals = {
    createRunDir: store.createRunDir.bind(store),
    initializeRunBundle: store.initializeRunBundle.bind(store),
    writeSnapshot: store.writeSnapshot.bind(store),
    writeLive: store.writeLive.bind(store),
    appendTrace: store.appendTrace.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    ensureSessionBundle: store.ensureSessionBundle.bind(store),
    writeSessionRecord: store.writeSessionRecord.bind(store),
    appendSessionEvent: store.appendSessionEvent.bind(store),
  };
  const afterSettlement: string[] = [];
  const operations: string[] = [];
  let active = 0;
  let returned = false;
  let heldCalls = 0;
  let releasedByTest = false;
  let heldFinished = false;

  async function tracked<T>(name: string, run: () => Promise<T>): Promise<T> {
    active += 1;
    operations.push(`start:${name}`);
    if (returned) {
      afterSettlement.push(`start:${name}`);
    }
    try {
      return await run();
    } finally {
      operations.push(`finish:${name}`);
      if (returned) {
        afterSettlement.push(`finish:${name}`);
      }
      active -= 1;
    }
  }

  async function stopAtPublication<T>(run: () => Promise<T>): Promise<T> {
    heldCalls += 1;
    assert.equal(heldCalls, 1, "only the selected final publication may reach the barrier");
    entered.release();
    await released.promise;
    try {
      if (failure) {
        throw failure;
      }
      return await run();
    } finally {
      heldFinished = true;
    }
  }

  // These wrappers observe all disk-producing store entry points. Calls nested
  // within another store operation stay tracked until their actual I/O settles.
  t.mock.method(store, "createRunDir", (...args: Parameters<FlowRunStore["createRunDir"]>) =>
    tracked("createRunDir", () => originals.createRunDir(...args)),
  );
  t.mock.method(
    store,
    "initializeRunBundle",
    (...args: Parameters<FlowRunStore["initializeRunBundle"]>) =>
      tracked("initializeRunBundle", () => originals.initializeRunBundle(...args)),
  );
  t.mock.method(store, "writeSnapshot", (...args: Parameters<FlowRunStore["writeSnapshot"]>) =>
    tracked("writeSnapshot", () => originals.writeSnapshot(...args)),
  );
  t.mock.method(store, "writeLive", (...args: Parameters<FlowRunStore["writeLive"]>) =>
    tracked("writeLive", () => originals.writeLive(...args)),
  );
  t.mock.method(store, "appendTrace", (...args: Parameters<FlowRunStore["appendTrace"]>) =>
    tracked("appendTrace", () => originals.appendTrace(...args)),
  );
  t.mock.method(
    store,
    "ensureSessionBundle",
    (...args: Parameters<FlowRunStore["ensureSessionBundle"]>) =>
      tracked("ensureSessionBundle", () => originals.ensureSessionBundle(...args)),
  );
  t.mock.method(
    store,
    "appendSessionEvent",
    (...args: Parameters<FlowRunStore["appendSessionEvent"]>) =>
      tracked("appendSessionEvent", () => {
        const message = args[3] as WireMessage;
        return boundary === "event" && message.error?.message === `SYNTHETIC_FAILURE_${marker}`
          ? stopAtPublication(() => originals.appendSessionEvent(...args))
          : originals.appendSessionEvent(...args);
      }),
  );
  t.mock.method(
    store,
    "writeSessionRecord",
    (...args: Parameters<FlowRunStore["writeSessionRecord"]>) =>
      tracked("writeSessionRecord", () => {
        const record = args[3];
        const finalized = JSON.stringify(record.messages).includes(`DIAGNOSTIC_${marker}`);
        return boundary === "record" && finalized
          ? stopAtPublication(() => originals.writeSessionRecord(...args))
          : originals.writeSessionRecord(...args);
      }),
  );
  t.mock.method(store, "writeArtifact", (...args: Parameters<FlowRunStore["writeArtifact"]>) =>
    tracked("writeArtifact", () => {
      const [, , content, options] = args;
      const raw =
        content === `DIAGNOSTIC_${marker}` &&
        options.mediaType === "text/plain" &&
        options.attemptId === "work#1" &&
        options.sessionId !== undefined;
      return boundary === "raw" && raw
        ? stopAtPublication(() => originals.writeArtifact(...args))
        : originals.writeArtifact(...args);
    }),
  );

  return {
    entered: entered.promise,
    release() {
      releasedByTest = true;
      released.release();
    },
    markReturned() {
      returned = true;
    },
    assertHeld() {
      assert.equal(heldCalls, 1);
      assert.equal(releasedByTest, false);
      assert.equal(heldFinished, false);
      assert.ok(active > 0, "the final publication must still own work");
    },
    assertDrained() {
      assert.equal(releasedByTest, true);
      assert.equal(heldFinished, true);
      assert.equal(active, 0, `store operations still active: ${operations.join(", ")}`);
      assert.deepEqual(afterSettlement, [], "bundle I/O continued after run settlement");
    },
  };
}

async function captureTreeHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        hashes[path.relative(directory, file)] = createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex");
      } else {
        assert.fail(`unexpected non-regular bundle entry: ${file}`);
      }
    }
  }
  await visit(directory);
  return hashes;
}

async function assertCaptureStopped(
  outputRoot: string,
  barrier: ReturnType<typeof holdCapturePublication>,
): Promise<void> {
  barrier.assertDrained();
  const before = await captureTreeHashes(outputRoot);
  await captureNextTurn();
  assert.deepEqual(await captureTreeHashes(outputRoot), before);
  barrier.assertDrained();
}

function assertCapturedPromptReply(
  receipts: PeerReceipt[],
  mode: "success" | "rpc-error",
  marker: string,
) {
  const prompts = requests(receipts, "session/prompt");
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  const replies = receipts.filter(
    (entry) =>
      entry.kind === "sent" &&
      entry.pid === prompt.pid &&
      entry.message?.id === prompt.message?.id &&
      entry.message?.method === undefined,
  );
  assert.equal(replies.length, 1);
  if (mode === "rpc-error") {
    assert.deepEqual(replies[0].message?.error, {
      code: -32077,
      message: `SYNTHETIC_FAILURE_${marker}`,
    });
  } else {
    assert.equal(replies[0].message?.result?.stopReason, "end_turn");
  }
}

async function assertPublishedDiagnostic(bundle: Bundle, prompt: string, marker: string) {
  assert.ok(JSON.stringify(bundle.record.messages).includes(prompt));
  assert.ok(JSON.stringify(bundle.record.messages).includes(`DIAGNOSTIC_${marker}`));
  const expectedHash = createHash("sha256").update(`DIAGNOSTIC_${marker}`).digest("hex");
  const publications = bundle.trace.filter(
    (event) =>
      event.type === "artifact_written" &&
      event.attemptId === "work#1" &&
      event.artifact?.sha256 === expectedHash,
  );
  assert.equal(publications.length, 1, "the raw artifact must finish before settlement");
  assert.equal(await readArtifact(bundle.runDir, publications[0].artifact), `DIAGNOSTIC_${marker}`);
}

for (const isolated of [true, false]) {
  for (const boundary of ["record", "raw"] as const) {
    test(
      `RPC failure waits for held ${boundary} publication in ${isolated ? "isolated" : "persistent"} flow`,
      { timeout: 45_000 },
      async (t) => {
        await withTempHome("acpx-held-rpc-capture-", async (home) => {
          const peer = await fixture(home);
          const marker = `${boundary}-held-error`;
          const prompt = `rpc-error:${marker}`;
          const barrier = holdCapturePublication(t, peer.runner, boundary, marker);
          let parseCalls = 0;
          let nextCalls = 0;
          const signalListeners = process.listenerCount("SIGHUP");
          const observed = observeCaptureRun(
            peer.runner.run(
              defineFlow({
                name: "held-rpc-capture",
                startAt: "work",
                nodes: {
                  work: acp({
                    heartbeatMs: 0,
                    timeoutMs: 20_000,
                    session: isolated ? { isolated: true } : { handle: "same-session" },
                    prompt: () => prompt,
                    parse: () => {
                      parseCalls += 1;
                      return "unexpected";
                    },
                  }),
                  next: compute({
                    run: () => {
                      nextCalls += 1;
                      return "unexpected";
                    },
                  }),
                },
                edges: [{ from: "work", to: "next" }],
              }),
              {},
            ),
            barrier.markReturned,
          );
          try {
            await captureWithin(
              Promise.race([
                barrier.entered,
                observed.outcome.then(() => {
                  throw new Error("run ended before publication barrier");
                }),
              ]),
              "RPC publication barrier",
            );
            assertCapturedPromptReply(await peer.receipts(), "rpc-error", marker);
            await captureNextTurn();
            barrier.assertHeld();
            assert.equal(
              observed.settled(),
              false,
              "RPC rejection escaped before capture publication",
            );
            assert.equal(parseCalls, 0);
            assert.equal(nextCalls, 0);
            barrier.release();
            const outcome = await captureWithin(observed.outcome, "released RPC capture");
            assert.ok(outcome.status === "rejected");
            assert.ok(outcome.reason instanceof Error);
            assert.match(outcome.reason.message, new RegExp(`SYNTHETIC_FAILURE_${marker}`));
            const bundle = await loadBundle(peer.outputRoot);
            assert.equal(bundle.state.status, "failed");
            assert.equal(bundle.steps.length, 1);
            await assertAttempt(bundle, "work", prompt, marker, "failed");
            assert.equal(parseCalls, 0);
            assert.equal(nextCalls, 0);
            assertPeerIdentity(bundle, await peer.receipts(), 1);
            await assertCaptureStopped(peer.outputRoot, barrier);
          } finally {
            barrier.release();
            // Invoke the actual FlowRunner interruption listener only if an
            // earlier assertion failed while it still owns this run.
            if (!observed.settled() && process.listenerCount("SIGHUP") > signalListeners) {
              process.emit("SIGHUP");
            }
            await captureWithin(observed.outcome, "held RPC test cleanup");
          }
        });
      },
    );

    for (const interruption of ["timeout", "interrupt"] as const) {
      test(
        `${interruption} drains held ${boundary} publication after ${isolated ? "isolated" : "persistent"} ACP success`,
        { timeout: 45_000 },
        async (t) => {
          await withTempHome("acpx-held-aborted-capture-", async (home) => {
            const peer = await fixture(home);
            const marker = `${boundary}-held-${interruption}`;
            const prompt = `success:${marker}`;
            const barrier = holdCapturePublication(t, peer.runner, boundary, marker);
            let parseCalls = 0;
            let nextCalls = 0;
            let attemptSignal: AbortSignal | undefined;
            const aborted = captureDeferred();
            const signalListeners = process.listenerCount("SIGHUP");
            let triggerDeadline: (() => void) | undefined;
            let restoreTimer: (() => void) | undefined;
            if (interruption === "timeout") {
              const timerMock = t.mock.method(
                globalThis,
                "setTimeout",
                (...args: Parameters<typeof setTimeout>) => {
                  const timer = captureRealSetTimeout(...args);
                  const [callback, delay, ...callbackArgs] = args;
                  if (delay === 20_000) {
                    assert.equal(
                      triggerDeadline,
                      undefined,
                      "only one attempt deadline is expected",
                    );
                    triggerDeadline = () => {
                      captureRealClearTimeout(timer);
                      callback(...callbackArgs);
                    };
                  }
                  return timer;
                },
              );
              restoreTimer = () => timerMock.mock.restore();
            }
            const observed = observeCaptureRun(
              peer.runner.run(
                defineFlow({
                  name: "held-aborted-capture",
                  startAt: "work",
                  nodes: {
                    work: acp({
                      heartbeatMs: 0,
                      timeoutMs: 20_000,
                      session: isolated ? { isolated: true } : { handle: "same-session" },
                      prompt: ({ signal }) => {
                        assert.ok(signal);
                        attemptSignal = signal;
                        signal.addEventListener("abort", aborted.release, { once: true });
                        return prompt;
                      },
                      parse: () => {
                        parseCalls += 1;
                        return "unexpected";
                      },
                    }),
                    next: compute({
                      run: () => {
                        nextCalls += 1;
                        return "unexpected";
                      },
                    }),
                  },
                  edges: [{ from: "work", to: "next" }],
                }),
                {},
              ),
              barrier.markReturned,
            );
            try {
              await captureWithin(
                Promise.race([
                  barrier.entered,
                  observed.outcome.then(() => {
                    throw new Error("run ended before publication barrier");
                  }),
                ]),
                "successful publication barrier",
              );
              assertCapturedPromptReply(await peer.receipts(), "success", marker);
              assert.ok(attemptSignal && !attemptSignal.aborted);
              barrier.assertHeld();
              if (interruption === "timeout") {
                // Invoke the captured deadline callback only after the real reply.
                assert.ok(triggerDeadline);
                triggerDeadline();
                restoreTimer?.();
                restoreTimer = undefined;
              } else {
                assert.ok(process.listenerCount("SIGHUP") > signalListeners);
                assert.equal(process.emit("SIGHUP"), true);
              }
              await captureWithin(aborted.promise, "attempt cancellation observation");
              assert.ok(attemptSignal.aborted);
              assert.ok(
                interruption === "timeout"
                  ? attemptSignal.reason instanceof TimeoutError
                  : attemptSignal.reason instanceof InterruptedError,
              );
              await captureNextTurn();
              assert.equal(
                observed.settled(),
                false,
                "abort settled before its admitted write drained",
              );
              barrier.assertHeld();
              assert.equal(parseCalls, 0);
              assert.equal(nextCalls, 0);
              barrier.release();
              const outcome = await captureWithin(observed.outcome, "released aborted capture");
              assert.ok(outcome.status === "rejected");
              assert.ok(
                interruption === "timeout"
                  ? outcome.reason instanceof TimeoutError
                  : outcome.reason instanceof InterruptedError,
              );
              const bundle = await loadBundle(peer.outputRoot);
              assert.equal(
                bundle.state.status,
                interruption === "timeout" ? "timed_out" : "failed",
              );
              assert.equal(
                bundle.state.results.work?.outcome,
                interruption === "timeout" ? "timed_out" : "cancelled",
              );
              assert.equal(Object.hasOwn(bundle.state.results, "next"), false);
              assert.equal(Object.hasOwn(bundle.state.outputs, "work"), false);
              assert.equal(parseCalls, 0);
              assert.equal(nextCalls, 0);
              // Existing process interruption can omit finalized step linkage;
              // do not turn this test into a new interruption schema contract.
              await assertPublishedDiagnostic(bundle, prompt, marker);
              assertPeerIdentity(bundle, await peer.receipts(), 1);
              await assertCaptureStopped(peer.outputRoot, barrier);
            } finally {
              restoreTimer?.();
              barrier.release();
              if (!observed.settled() && process.listenerCount("SIGHUP") > signalListeners) {
                process.emit("SIGHUP");
              }
              await captureWithin(observed.outcome, "held cancellation test cleanup");
            }
          });
        },
      );
    }
  }
}

// Common finalizer precedence needs only the isolated real-peer lane here; both
// ownership lanes already execute held writes in the matrix above.
for (const boundary of ["record", "raw"] as const) {
  for (const mode of ["rpc-error", "success"] as const) {
    test(
      `${mode} keeps the correct failure when ${boundary} publication also fails`,
      { timeout: 45_000 },
      async (t) => {
        await withTempHome("acpx-publication-error-", async (home) => {
          const peer = await fixture(home);
          const marker = `${boundary}-publication-failure`;
          const storageError = Object.freeze(new Error(`SYNTHETIC_${boundary}_STORAGE_FAILURE`));
          const barrier = holdCapturePublication(t, peer.runner, boundary, marker, storageError);
          let parseCalls = 0;
          let nextCalls = 0;
          const signalListeners = process.listenerCount("SIGHUP");
          const observed = observeCaptureRun(
            peer.runner.run(
              defineFlow({
                name: "publication-error-precedence",
                startAt: "work",
                nodes: {
                  work: acp({
                    session: { isolated: true },
                    heartbeatMs: 0,
                    timeoutMs: 20_000,
                    prompt: () => `${mode}:${marker}`,
                    parse: () => {
                      parseCalls += 1;
                      return "unexpected";
                    },
                  }),
                  next: compute({
                    run: () => {
                      nextCalls += 1;
                      return "unexpected";
                    },
                  }),
                },
                edges: [{ from: "work", to: "next" }],
              }),
              {},
            ),
            barrier.markReturned,
          );
          try {
            await captureWithin(
              Promise.race([
                barrier.entered,
                observed.outcome.then(() => {
                  throw new Error("run ended before publication barrier");
                }),
              ]),
              "failing publication barrier",
            );
            assertCapturedPromptReply(await peer.receipts(), mode, marker);
            await captureNextTurn();
            assert.equal(observed.settled(), false);
            barrier.assertHeld();
            barrier.release();
            const outcome = await captureWithin(observed.outcome, "failed publication outcome");
            assert.ok(outcome.status === "rejected");
            if (mode === "rpc-error") {
              assert.notEqual(outcome.reason, storageError);
              assert.ok(outcome.reason instanceof Error);
              assert.match(outcome.reason.message, new RegExp(`SYNTHETIC_FAILURE_${marker}`));
            } else {
              assert.equal(outcome.reason, storageError, "preserve the actual finalizer failure");
            }
            assert.equal(parseCalls, 0);
            assert.equal(nextCalls, 0);
            // loadBundle requires a fully published record, which this injection
            // deliberately prevents for the record boundary. Read only the
            // terminal projections to avoid granting a false complete capture.
            const runDirs = await fs.readdir(peer.outputRoot);
            assert.equal(runDirs.length, 1);
            const runDir = path.join(peer.outputRoot, runDirs[0]);
            const state = await readJson<FlowRunState>(path.join(runDir, "projections/run.json"));
            const steps = await readJson<FlowStepRecord[]>(
              path.join(runDir, "projections/steps.json"),
            );
            assert.equal(state.status, "failed");
            assert.deepEqual(state.steps, steps);
            assert.equal(steps.length, 1);
            assert.equal(steps[0].outcome, "failed");
            assert.ok(outcome.reason instanceof Error);
            assert.equal(state.error, outcome.reason.message);
            assert.equal(steps[0].error, outcome.reason.message);
            assert.equal(steps[0].trace?.rawResponseArtifact, undefined);
            if (boundary === "record") {
              assert.equal(steps[0].trace?.conversation, undefined);
            } else {
              assert.ok(steps[0].trace?.conversation);
            }
            assert.equal(Object.hasOwn(state.results, "next"), false);
            await assertCaptureStopped(peer.outputRoot, barrier);
          } finally {
            barrier.release();
            if (!observed.settled() && process.listenerCount("SIGHUP") > signalListeners) {
              process.emit("SIGHUP");
            }
            await captureWithin(observed.outcome, "publication failure test cleanup");
          }
        });
      },
    );
  }
}

function observePromptRejection(t: TestContext, runner: FlowRunner) {
  type Capture = {
    run(operation: () => Promise<unknown>, ...rest: unknown[]): Promise<unknown>;
  };
  const harness = runner as unknown as {
    createPromptEventCapture(...args: unknown[]): Capture;
  };
  const original = harness.createPromptEventCapture.bind(runner);
  const rejected = captureDeferred();
  let reason: unknown;
  t.mock.method(harness, "createPromptEventCapture", (...args: unknown[]) => {
    const capture = original(...args);
    const run = capture.run.bind(capture);
    capture.run = (operation, ...rest) =>
      run(
        async () => {
          try {
            return await operation();
          } catch (error) {
            reason = error;
            rejected.release();
            throw error;
          }
        },
        ...rest,
      );
    return capture;
  });
  return { rejected: rejected.promise, reason: () => reason };
}

for (const isolated of [true, false]) {
  for (const boundary of ["event", "record", "raw"] as const) {
    for (const interruption of ["timeout", "interrupt"] as const) {
      test(
        `known RPC rejection retains enclosing ${interruption} policy during ${boundary} drain in ${isolated ? "isolated" : "persistent"} flow`,
        { timeout: 45_000 },
        async (t) => {
          await withTempHome("acpx-capture-error-abort-", async (home) => {
            const peer = await fixture(home);
            const marker = `${boundary}-error-${interruption}`;
            const barrier = holdCapturePublication(t, peer.runner, boundary, marker);
            const failure = observePromptRejection(t, peer.runner);
            let parseCalls = 0;
            let nextCalls = 0;
            let signal: AbortSignal | undefined;
            let fireDeadline: (() => void) | undefined;
            let restoreTimer: (() => void) | undefined;
            const cancelled = captureDeferred();
            const listeners = process.listenerCount("SIGHUP");
            if (interruption === "timeout") {
              const timerMock = t.mock.method(
                globalThis,
                "setTimeout",
                (...args: Parameters<typeof setTimeout>) => {
                  const timer = captureRealSetTimeout(...args);
                  const [callback, delay, ...callbackArgs] = args;
                  if (delay === 20_000) {
                    assert.equal(fireDeadline, undefined);
                    fireDeadline = () => {
                      captureRealClearTimeout(timer);
                      callback(...callbackArgs);
                    };
                  }
                  return timer;
                },
              );
              restoreTimer = () => timerMock.mock.restore();
            }
            const observed = observeCaptureRun(
              peer.runner.run(
                defineFlow({
                  name: "known-error-abort-policy",
                  startAt: "work",
                  nodes: {
                    work: acp({
                      session: isolated ? { isolated: true } : { handle: "same-session" },
                      heartbeatMs: 0,
                      timeoutMs: 20_000,
                      prompt: (context) => {
                        signal = context.signal;
                        signal?.addEventListener("abort", cancelled.release, { once: true });
                        return `rpc-error:${marker}`;
                      },
                      parse: () => {
                        parseCalls += 1;
                        return "unexpected";
                      },
                    }),
                    next: compute({
                      run: () => {
                        nextCalls += 1;
                        return "unexpected";
                      },
                    }),
                  },
                  edges: [{ from: "work", to: "next" }],
                }),
                {},
              ),
              barrier.markReturned,
            );
            try {
              await captureWithin(
                Promise.race([
                  Promise.all([barrier.entered, failure.rejected]),
                  observed.outcome.then(() => {
                    throw new Error("run settled before the known-error drain barrier");
                  }),
                ]),
                "known RPC error and held publication",
              );
              await captureNextTurn();
              const rpcError = failure.reason();
              assert.ok(rpcError instanceof Error);
              assert.equal(rpcError.message, `SYNTHETIC_FAILURE_${marker}`);
              assertCapturedPromptReply(await peer.receipts(), "rpc-error", marker);
              assert.ok(signal && !signal.aborted);
              barrier.assertHeld();
              if (interruption === "timeout") {
                assert.ok(fireDeadline);
                fireDeadline();
                restoreTimer?.();
                restoreTimer = undefined;
              } else {
                assert.ok(process.listenerCount("SIGHUP") > listeners);
                process.emit("SIGHUP");
              }
              await captureWithin(cancelled.promise, "enclosing cancellation");
              await captureNextTurn();
              assert.equal(observed.settled(), false);
              barrier.assertHeld();
              barrier.release();
              const outcome = await captureWithin(observed.outcome, "known-error drain completion");
              assert.ok(outcome.status === "rejected");
              assert.ok(outcome.reason instanceof AggregateError);
              assert.equal(outcome.reason.cause, signal.reason);
              assert.deepEqual(outcome.reason.errors, [signal.reason, rpcError]);
              assert.ok(
                interruption === "timeout"
                  ? signal.reason instanceof TimeoutError
                  : signal.reason instanceof InterruptedError,
              );
              assert.equal(parseCalls, 0);
              assert.equal(nextCalls, 0);
              const directories = await fs.readdir(peer.outputRoot);
              assert.equal(directories.length, 1);
              const state = await readJson<FlowRunState>(
                path.join(peer.outputRoot, directories[0], "projections/run.json"),
              );
              assert.equal(state.status, "failed");
              assert.equal(state.results.work?.outcome, "failed");
              assert.equal(Object.hasOwn(state.results, "next"), false);
              await assertCaptureStopped(peer.outputRoot, barrier);
            } finally {
              restoreTimer?.();
              barrier.release();
              if (!observed.settled() && process.listenerCount("SIGHUP") > listeners) {
                process.emit("SIGHUP");
              }
              await captureWithin(observed.outcome, "known-error cancellation cleanup");
            }
          });
        },
      );
    }
  }
}
