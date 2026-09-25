import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFilesystemBundleReader } from "../examples/flows/replay-viewer/server/filesystem-bundle-reader.js";
import { createFilesystemRunSource } from "../examples/flows/replay-viewer/server/live-source.js";
import type { BundleReader } from "../examples/flows/replay-viewer/src/lib/bundle-reader.js";
import { loadRunBundle } from "../examples/flows/replay-viewer/src/lib/load-bundle.js";
import { selectAttemptView } from "../examples/flows/replay-viewer/src/lib/view-model-conversation.js";
import type {
  FlowBundledSessionEvent,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowStepRecord,
  LoadedRunBundle,
  SessionRecord,
} from "../examples/flows/replay-viewer/src/types.js";
import {
  CHECKPOINT_COUNTS,
  LONG_SUFFIX,
  LONG_TURN,
  TURN_COUNT,
  answerForTurn,
  nodeForTurn,
  promptForTurn,
  CAPTURE_FAILURE_BOUND_MS,
  PEER_RETIREMENT_GRACE_MS,
  PRODUCER_KILL_GRACE_MS,
  PRODUCER_TERM_GRACE_MS,
  PRODUCER_TIMEOUT_MS,
} from "./fixtures/viewer-lossless-contract.js";

const AT = "2026-09-25T00:00:00.000Z";
const SESSION = "synthetic-session";
const binding: FlowSessionBinding = {
  key: "synthetic",
  handle: "main",
  bundleId: SESSION,
  name: "synthetic",
  agentName: "mock",
  agentCommand: "synthetic",
  cwd: "/synthetic",
  acpxRecordId: "synthetic-record",
  acpSessionId: "synthetic-provider",
};
const user = (id: string, text: string) => ({ User: { id, content: [{ Text: text }] } });
const agent = (text: string) => ({ Agent: { content: [{ Text: text }], tool_results: {} } });

function event(seq: number, text: string, prompt = false): FlowBundledSessionEvent {
  return {
    seq,
    at: AT,
    direction: prompt ? "outbound" : "inbound",
    message: prompt
      ? {
          jsonrpc: "2.0",
          id: seq,
          method: "session/prompt",
          params: { sessionId: "synthetic-provider", prompt: [{ type: "text", text }] },
        }
      : {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "synthetic-provider",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          },
        },
  };
}

function settledStep(
  attempt: number,
  start: number,
  end: number,
  firstSeq: number,
  lastSeq: number,
): FlowStepRecord {
  return {
    attemptId: `turn#${attempt}`,
    nodeId: "turn",
    nodeType: "acp",
    outcome: "ok",
    startedAt: AT,
    finishedAt: AT,
    promptText: null,
    rawText: null,
    output: null,
    session: binding,
    agent: { agentName: "mock", agentCommand: "synthetic", cwd: "/synthetic" },
    trace: {
      sessionId: SESSION,
      conversation: {
        sessionId: SESSION,
        messageStart: start,
        messageEnd: end,
        eventStartSeq: firstSeq,
        eventEndSeq: lastSeq,
      },
    },
  };
}

function syntheticReader(options: {
  messages: unknown[];
  lastSeq: number;
  events: FlowBundledSessionEvent[];
  steps: FlowStepRecord[];
  activeAttempt?: number;
}) {
  const manifest: FlowRunManifest = {
    schema: "acpx.flow-run-bundle.v1",
    runId: "synthetic",
    flowName: "synthetic",
    startedAt: AT,
    status: options.activeAttempt ? "running" : "completed",
    traceSchema: "acpx.flow-trace-event.v1",
    paths: {
      flow: "flow.json",
      trace: "trace.ndjson",
      runProjection: "run.json",
      liveProjection: "live.json",
      stepsProjection: "steps.json",
      sessionsDir: "sessions",
      artifactsDir: "artifacts",
    },
    sessions: [
      {
        id: SESSION,
        handle: "main",
        bindingPath: "binding.json",
        recordPath: "record.json",
        eventsPath: "events.ndjson",
      },
    ],
  };
  const run: FlowRunState = {
    runId: "synthetic",
    flowName: "synthetic",
    startedAt: AT,
    updatedAt: AT,
    status: manifest.status,
    input: {},
    outputs: {},
    results: {},
    steps: options.steps,
    sessionBindings: { synthetic: binding },
    ...(options.activeAttempt
      ? {
          currentNode: "turn",
          currentNodeType: "acp" as const,
          currentAttemptId: `turn#${options.activeAttempt}`,
          currentNodeStartedAt: AT,
        }
      : {}),
  };
  const record: SessionRecord = {
    createdAt: AT,
    updated_at: AT,
    lastUsedAt: AT,
    lastSeq: options.lastSeq,
    title: null,
    messages: options.messages,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
  const files = new Map<string, string>([
    ["manifest.json", JSON.stringify(manifest)],
    ["run.json", JSON.stringify(run)],
    ["live.json", JSON.stringify(run)],
    ["steps.json", JSON.stringify(options.steps)],
    [
      "flow.json",
      JSON.stringify({
        schema: "acpx.flow-definition-snapshot.v1",
        name: "synthetic",
        startAt: "turn",
        nodes: { turn: { nodeType: "acp", session: { handle: "main", isolated: false } } },
        edges: [],
      }),
    ],
    ["binding.json", JSON.stringify(binding)],
    ["record.json", JSON.stringify(record)],
    ["events.ndjson", options.events.map((value) => JSON.stringify(value)).join("\n")],
    [
      "trace.ndjson",
      options.activeAttempt
        ? JSON.stringify({
            seq: 1,
            at: AT,
            runId: "synthetic",
            scope: "acp",
            type: "acp_prompt_prepared",
            attemptId: run.currentAttemptId,
            nodeId: "turn",
            sessionId: SESSION,
            payload: { sessionId: SESSION },
          })
        : "",
    ],
  ]);
  const reader: BundleReader = {
    sourceType: "local",
    label: "synthetic",
    readText: async (name) => {
      const value = files.get(name);
      assert.notEqual(value, undefined, `Unexpected fixture read ${name}`);
      return value!;
    },
  };
  return { reader, files, record };
}

function selected(bundle: LoadedRunBundle, attemptId: string) {
  const index = bundle.steps.findIndex((step) => step.attemptId === attemptId);
  assert.ok(index >= 0, `Missing recorded attempt ${attemptId}`);
  const view = selectAttemptView(bundle, index);
  assert.ok(view);
  assert.equal(view.sessionFromFallback, false);
  return view;
}

function highlighted(bundle: LoadedRunBundle, attemptId: string): string[] {
  return selected(bundle, attemptId)
    .sessionSlice.filter((message) => message.highlighted)
    .flatMap((message) => message.textBlocks);
}

function onlySession(bundle: LoadedRunBundle) {
  const sessions = Object.values(bundle.sessions);
  assert.equal(sessions.length, 1);
  return sessions[0];
}

function userId(message: unknown): string {
  assert.ok(message && typeof message === "object" && "User" in message);
  const value = message.User as { id?: unknown };
  assert.equal(typeof value.id, "string");
  return value.id as string;
}

async function readRaw(outputRoot: string, runId: string) {
  const reader = createFilesystemBundleReader(outputRoot, { runId });
  const manifest = JSON.parse(await reader.readText("manifest.json")) as FlowRunManifest;
  assert.equal(manifest.sessions.length, 1);
  const entry = manifest.sessions[0];
  const paths = [
    entry.recordPath,
    entry.eventsPath,
    manifest.paths.stepsProjection,
    manifest.paths.trace,
  ];
  const bytes = await Promise.all(paths.map((name) => reader.readText(name)));
  return {
    reader,
    bytes,
    record: JSON.parse(bytes[0]) as SessionRecord,
    events: bytes[1]
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FlowBundledSessionEvent),
    steps: JSON.parse(bytes[2]) as FlowStepRecord[],
  };
}

async function assertLoaderParity(outputRoot: string, runId: string) {
  const raw = await readRaw(outputRoot, runId);
  const direct = await loadRunBundle(raw.reader);
  const fresh = await createFilesystemRunSource(outputRoot).getRunState(runId);
  assert.deepEqual(direct.sessions, fresh.sessions);
  assert.deepEqual(direct.steps, fresh.steps);
  assert.deepEqual(direct.run.steps, direct.steps);
  if (direct.live) {
    assert.deepEqual(direct.live.steps, direct.steps);
  }
  for (const step of raw.steps) {
    const projected = direct.steps.find((value) => value.attemptId === step.attemptId);
    assert.equal(
      projected?.trace?.conversation?.eventStartSeq,
      step.trace?.conversation?.eventStartSeq,
    );
    assert.equal(
      projected?.trace?.conversation?.eventEndSeq,
      step.trace?.conversation?.eventEndSeq,
    );
  }
  assert.deepEqual(onlySession(direct).events, raw.events);
  assert.deepEqual(
    (await readRaw(outputRoot, runId)).bytes,
    raw.bytes,
    "loaders must not rewrite source bundle bytes",
  );
  return { direct, raw };
}

async function originalRollover() {
  const messages = Array.from({ length: 100 }, (_, index) => [
    user(`saved-${index}`, `prompt ${index}`),
    agent(`answer ${index}`),
  ]).flat();
  const longAnswer = `${"a".repeat(7_999)}  ${LONG_SUFFIX}`;
  const fixture = syntheticReader({
    messages,
    lastSeq: 200,
    steps: [settledStep(1, 0, 1, 1, 2)],
    activeAttempt: 101,
    events: [event(201, "CURRENT PROMPT", true), event(202, longAnswer)],
  });
  const before = [...fixture.files.entries()];
  const bundle = await loadRunBundle(fixture.reader);
  assert.equal(onlySession(bundle).record.messages?.length, 202);
  assert.deepEqual(highlighted(bundle, "turn#1"), ["prompt 0", "answer 0"]);
  assert.deepEqual(highlighted(bundle, "turn#101"), ["CURRENT PROMPT", longAnswer]);
  const range = selected(bundle, "turn#101").step.trace?.conversation;
  assert.equal(range?.messageStart, 200);
  assert.equal(range?.messageEnd, 201);
  assert.deepEqual([...fixture.files.entries()], before);
  assert.equal(fixture.record.messages?.length, 200);
}

async function coldFinishedCapture(root: string, runId: string) {
  // No loader/source has read this finished capture before these calls.
  const { direct, raw } = await assertLoaderParity(path.join(root, "runs"), runId);
  assert.equal(
    raw.record.messages?.length,
    200,
    "the producer must still persist bounded runtime history",
  );
  assert.equal(raw.steps.length, TURN_COUNT);
  assert.equal(direct.run.status, "completed");
  assert.equal(onlySession(direct).record.messages?.length, TURN_COUNT * 2);
  for (const index of [0, LONG_TURN, TURN_COUNT - 1]) {
    const step = direct.steps.find((value) => value.nodeId === nodeForTurn(index));
    assert.ok(step);
    assert.deepEqual(highlighted(direct, step.attemptId), [
      promptForTurn(index),
      answerForTurn(index),
    ]);
    assert.equal(step.trace?.conversation?.messageStart, index * 2);
    assert.equal(step.trace?.conversation?.messageEnd, index * 2 + 1);
  }
  const rawText = JSON.stringify(raw.record.messages);
  assert.equal(
    rawText.includes(LONG_SUFFIX),
    false,
    "the final checkpoint must actually exercise text truncation",
  );
  assert.equal(JSON.stringify(raw.events).includes(LONG_SUFFIX), true);
}

async function repeatedCheckpointProgression(root: string, runId: string) {
  const savedIds = new Map<number, string>();
  const snapshots: Array<{ completed: number; bundle: LoadedRunBundle }> = [];
  for (const completed of CHECKPOINT_COUNTS) {
    const { direct, raw } = await assertLoaderParity(
      path.join(root, "checkpoints", String(completed)),
      runId,
    );
    const rawMessages = raw.record.messages ?? [];
    assert.equal(rawMessages.length, Math.min(completed * 2, 200));
    // Position derives from the producer's known final turn at this checkpoint,
    // never from matching equal prompt text against another turn.
    savedIds.set(completed - 1, userId(rawMessages.at(-2)));
    assert.equal(onlySession(direct).record.messages?.length, completed * 2);
    const current = direct.run.currentAttemptId;
    if (current && direct.steps.some((step) => step.attemptId === current)) {
      assert.deepEqual(
        highlighted(direct, current),
        [],
        "a prepared but unsent prompt must not borrow the previous turn",
      );
    }
    snapshots.push({ completed, bundle: direct });
  }
  assert.equal(new Set(savedIds.values()).size, CHECKPOINT_COUNTS.length);
  const final = (await assertLoaderParity(path.join(root, "runs"), runId)).direct;
  snapshots.push({ completed: TURN_COUNT, bundle: final });
  for (const { completed, bundle } of snapshots) {
    for (const [index, expectedId] of savedIds) {
      if (index >= completed) {
        continue;
      }
      const step = bundle.steps.find((value) => value.nodeId === nodeForTurn(index));
      assert.ok(step);
      assert.deepEqual(highlighted(bundle, step.attemptId), [
        promptForTurn(index),
        answerForTurn(index),
      ]);
      assert.equal(step.trace?.conversation?.messageStart, index * 2);
      assert.equal(step.trace?.conversation?.messageEnd, index * 2 + 1);
      assert.equal(userId(onlySession(bundle).record.messages?.[index * 2]), expectedId);
    }
  }
}

async function incompleteCaptureControls() {
  const checkpoint = [
    user("checkpoint-owned-id", "CHECKPOINT_ONLY_PROMPT"),
    agent("saved prefix..."),
  ];
  const checkpointOnly = syntheticReader({
    messages: checkpoint,
    lastSeq: 5,
    events: [],
    steps: [settledStep(1, 0, 1, 1, 5)],
  });
  const only = await loadRunBundle(checkpointOnly.reader);
  assert.deepEqual(onlySession(only).record.messages, checkpoint);
  assert.deepEqual(highlighted(only, "turn#1"), ["CHECKPOINT_ONLY_PROMPT", "saved prefix..."]);
  assert.deepEqual(onlySession(only).events, []);

  const fragment = [event(1, "UNRELATED_EVENT_PROMPT", true), event(3, "RECORDED_FRAGMENT")];
  const incompatible = syntheticReader({
    messages: checkpoint,
    lastSeq: 3,
    events: fragment,
    steps: [settledStep(1, 0, 1, 1, 3)],
  });
  const bundle = await loadRunBundle(incompatible.reader);
  assert.deepEqual(onlySession(bundle).events, fragment);
  const messages = onlySession(bundle).record.messages ?? [];
  assert.ok(messages.some((value) => JSON.stringify(value) === JSON.stringify(checkpoint[0])));
  assert.ok(messages.some((value) => JSON.stringify(value) === JSON.stringify(checkpoint[1])));
  assert.equal(
    highlighted(bundle, "turn#1").includes("CHECKPOINT_ONLY_PROMPT"),
    false,
    "an incompatible/gapped event interval cannot inherit unrelated checkpoint indices",
  );
  const checkpointIdOwners = messages.filter(
    (value) =>
      value &&
      typeof value === "object" &&
      "User" in value &&
      (value.User as { id?: unknown }).id === "checkpoint-owned-id",
  );
  assert.deepEqual(
    checkpointIdOwners,
    [checkpoint[0]],
    "do not transplant a saved identity by position",
  );
  assert.deepEqual(selected(bundle, "turn#1").rawEventSlice, fragment);
  // No claim that the ambiguous historical fragment was reconstructed losslessly.
}

function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForFixturePeers(root: string, deadline: number, requireStarted: boolean) {
  for (;;) {
    const text = await fs
      .readFile(path.join(root, "peer-receipts.ndjson"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
    const rows = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { instanceId: string; kind: string; detail?: number | string },
      );
    const started = rows.filter((row) => row.kind === "started");
    const exited = new Map(
      rows.filter((row) => row.kind === "exited").map((row) => [row.instanceId, row.detail]),
    );
    if (started.every((row) => exited.has(row.instanceId))) {
      if (requireStarted) {
        assert.ok(started.length > 0, "successful production requires observed fixture peers");
      }
      return { started, exited };
    }
    assert.ok(Date.now() < deadline, "peer retirement unverified; retain the owned fixture root");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function produceCapture(root: string): Promise<string> {
  const producer = fileURLToPath(
    new URL("./fixtures/viewer-lossless-producer.js", import.meta.url),
  );
  for (const directory of ["home", "tmp"]) {
    await fs.mkdir(path.join(root, directory));
  }
  const failureDeadlineAt = Date.now() + CAPTURE_FAILURE_BOUND_MS;
  const child = spawn(
    process.execPath,
    ["--unhandled-rejections=strict", producer, root, String(failureDeadlineAt)],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        SystemRoot: process.env.SystemRoot,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  let stdoutEnded = false;
  let stderrEnded = false;
  let closed = false;
  let overflow = false;
  let produced = false;
  let runId: string | undefined;
  const failures: unknown[] = [];
  const capture = (current: string, chunk: Buffer) => {
    const next = current + chunk.toString();
    if (next.length > 1_048_576) {
      overflow = true;
      child.kill("SIGTERM");
    }
    return next.slice(0, 1_048_576);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = capture(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = capture(stderr, chunk);
  });
  child.stdout.on("end", () => {
    stdoutEnded = true;
  });
  child.stderr.on("end", () => {
    stderrEnded = true;
  });
  const completion = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    },
  );
  // Attach the rejection observer immediately, including spawn failures.
  void completion.catch(() => {});
  try {
    const result = await within(
      completion,
      PRODUCER_TIMEOUT_MS,
      "producer exceeded its capture deadline",
    );
    assert.equal(overflow, false);
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0, stderr);
    assert.equal(stdoutEnded && stderrEnded, true, "both producer pipe EOFs are required");
    const receipt = JSON.parse(stdout.trim()) as { runId: string; turnCount: number };
    assert.equal(receipt.turnCount, TURN_COUNT);
    assert.match(receipt.runId, /^[a-zA-Z0-9-]+$/u);
    produced = true;
    runId = receipt.runId;
  } catch (error) {
    failures.push(error);
  }
  if (!closed) {
    try {
      // FlowRunner registers withInterrupt's SIGTERM handler during execution.
      // Outside that interval/platform semantics, this is only an owned stop
      // attempt: it never earns normal-retirement credit.
      child.kill("SIGTERM");
      try {
        await within(completion, PRODUCER_TERM_GRACE_MS, "producer retirement grace elapsed");
      } catch {
        child.kill("SIGKILL"); // Retained producer handle only, never receipt PIDs.
        await within(completion, PRODUCER_KILL_GRACE_MS, "producer close remains unverified");
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) {
    try {
      const peers = await waitForFixturePeers(root, Date.now() + PEER_RETIREMENT_GRACE_MS, true);
      for (const peer of peers.started) {
        assert.equal(
          peers.exited.get(peer.instanceId),
          0,
          "every normal fixture peer must report exit 0 before fallback retirement",
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    // Failure containment only: wait for the preassigned absolute deadline.
    // A late/self-deadline exit cannot erase the failed normal qualification.
    try {
      await waitForFixturePeers(root, failureDeadlineAt + PEER_RETIREMENT_GRACE_MS, produced);
    } catch (error) {
      failures.push(error);
    }
    throw new AggregateError(failures, "Synthetic capture or owned cleanup failed");
  }
  assert.ok(runId);
  return runId;
}

test(
  "viewer lossless history across rollover, cold capture, and checkpoints",
  { timeout: 440_000 },
  async (t) => {
    const completed = new Set<string>();
    const scenario = async (name: string, run: () => Promise<void>) => {
      await t.test(name, async () => {
        await run();
        completed.add(name);
      });
    };
    await scenario("original 200-message checkpoint plus lossless tail", originalRollover);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-lossless-"));
    let passed = false;
    try {
      let runId: string | undefined;
      let captureError: unknown;
      try {
        runId = await produceCapture(root);
      } catch (error) {
        captureError = error;
      }
      const capturedRun = () => {
        if (runId === undefined) {
          throw new Error("Shared producer capture unavailable; this scenario was not qualified", {
            cause: captureError,
          });
        }
        return runId;
      };
      await scenario("cold finished capture restores first, middle, and latest real turns", () =>
        coldFinishedCapture(root, capturedRun()),
      );
      await scenario("repeated prompts keep distinct saved IDs across checkpoint rollover", () =>
        repeatedCheckpointProgression(root, capturedRun()),
      );
      await scenario(
        "incomplete captures preserve evidence without false linkage",
        incompleteCaptureControls,
      );
      // Child tests retain their individual failures; an earlier red assertion
      // must not prevent the remaining independent scenarios from running.
      passed = completed.size === 4;
    } finally {
      if (passed) {
        await fs.rm(root, { recursive: true, force: true });
      } else {
        t.diagnostic(`Retained owned synthetic fixture for inspection: ${root}`);
      }
    }
  },
);
