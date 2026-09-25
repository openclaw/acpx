import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type {
  NewSessionResponse,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { AcpClient, type SessionCreateResult } from "../src/acp/client.js";
import { extractAcpError } from "../src/acp/error-normalization.js";
import { isRequestedModelUnsupportedError } from "../src/acp/model-support.js";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import { DISCARD_OUTPUT_FORMATTER } from "../src/session/execution/discard-output.js";
import { runOnce } from "../src/session/execution/runtime.js";

const SESSION_ID = "creation-catalog-session";
const FOREIGN_ID = "foreign-catalog-session";
const ADAPTER_ERROR_MESSAGE = "Synthetic catalog setter rejection";

// The current SDK omits this legacy wire field; acpx still explicitly supports it.
type InitialResponse = NewSessionResponse & {
  models?: Pick<NonNullable<SessionCreateResult["models"]>, "currentModelId" | "availableModels">;
};
type ConfigUpdate = { sessionId: string; configOptions: SessionConfigOption[] };
type ControlCall = {
  method: "session/set_config_option" | "session/set_model";
  params: Record<string, string>;
};
type ExpectedOutcome =
  | { kind: "success" }
  | { kind: "local"; reason: "missing-capability" | "unadvertised-model" }
  | { kind: "adapter"; sentinel: string };
type Scenario = {
  name: string;
  initial: InitialResponse;
  beforeResponse?: ConfigUpdate[];
  duringCapture?: ConfigUpdate[];
  request: { model: string } | { config: string };
  rejectSetter?: string;
  controls: ControlCall[];
  expected: ExpectedOutcome;
};

function modelConfig(prefix: string): SessionConfigOption[] {
  return [
    {
      id: "llm",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: `${prefix}-current`,
      options: ["current", "target"].map((suffix) => ({
        value: `${prefix}-${suffix}`,
        name: `${prefix}-${suffix}`,
      })),
    },
  ];
}

const A = modelConfig("a");
const B = modelConfig("b");
const C = modelConfig("c");
const CONFIG_A: InitialResponse = { sessionId: SESSION_ID, configOptions: A };
const LEGACY_L: InitialResponse = {
  sessionId: SESSION_ID,
  models: {
    currentModelId: "l-current",
    availableModels: ["l-current", "l-target"].map((modelId) => ({ modelId, name: modelId })),
  },
};
const EFFORT: SessionConfigOption[] = [
  {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: "low",
    options: ["low", "high"].map((value) => ({ value, name: value })),
  },
];
const owned = (configOptions: SessionConfigOption[]): ConfigUpdate => ({
  sessionId: SESSION_ID,
  configOptions,
});
const configCall = (value: string): ControlCall => ({
  method: "session/set_config_option",
  params: { sessionId: SESSION_ID, configId: "llm", value },
});
const legacyCall = (modelId: string): ControlCall => ({
  method: "session/set_model",
  params: { sessionId: SESSION_ID, modelId },
});
const success: ExpectedOutcome = { kind: "success" };
const missing: ExpectedOutcome = { kind: "local", reason: "missing-capability" };

const SCENARIOS: Scenario[] = [
  {
    name: "owned B-only config selection",
    initial: CONFIG_A,
    duringCapture: [owned(B)],
    request: { config: "b-target" },
    controls: [configCall("b-target")],
    expected: success,
  },
  {
    name: "owned B-only startup model selection",
    initial: CONFIG_A,
    duringCapture: [owned(B)],
    request: { model: "b-target" },
    controls: [configCall("b-target")],
    expected: success,
  },
  {
    name: "owned current model is a no-op",
    initial: CONFIG_A,
    duringCapture: [owned(B)],
    request: { model: "b-current" },
    controls: [],
    expected: success,
  },
  {
    name: "B then C uses the latest callback",
    initial: CONFIG_A,
    duringCapture: [owned(B), owned(C)],
    request: { config: "c-target" },
    controls: [configCall("c-target")],
    expected: success,
  },
  {
    name: "owned B rejects a selector removed from A",
    initial: CONFIG_A,
    duringCapture: [owned(B)],
    request: { config: "a-target" },
    controls: [],
    expected: { kind: "local", reason: "unadvertised-model" },
  },
  {
    name: "empty config catalog removes startup model support",
    initial: CONFIG_A,
    duringCapture: [owned([])],
    request: { model: "a-target" },
    controls: [],
    expected: missing,
  },
  {
    name: "raw config after removal reaches the adapter",
    initial: CONFIG_A,
    duringCapture: [owned([])],
    request: { config: "raw-after-removal" },
    rejectSetter: "removed-config",
    controls: [configCall("raw-after-removal")],
    expected: { kind: "adapter", sentinel: "removed-config" },
  },
  {
    name: "legacy then config then removal does not resurrect legacy",
    initial: LEGACY_L,
    duringCapture: [owned(B), owned([])],
    request: { model: "l-target" },
    controls: [],
    expected: missing,
  },
  {
    name: "empty config update preserves existing legacy control",
    initial: LEGACY_L,
    duringCapture: [owned([])],
    request: { model: "l-target" },
    controls: [legacyCall("l-target")],
    expected: success,
  },
  {
    name: "unrelated config update preserves existing legacy control",
    initial: LEGACY_L,
    duringCapture: [owned(EFFORT)],
    request: { model: "l-target" },
    controls: [legacyCall("l-target")],
    expected: success,
  },
  {
    name: "foreign callback cannot replace A",
    initial: CONFIG_A,
    duringCapture: [{ sessionId: FOREIGN_ID, configOptions: B }],
    request: { model: "a-target" },
    controls: [configCall("a-target")],
    expected: success,
  },
  {
    name: "pre-assignment callback cannot replace the later A response",
    initial: CONFIG_A,
    beforeResponse: [owned(B)],
    request: { model: "a-target" },
    controls: [configCall("a-target")],
    expected: success,
  },
  {
    name: "no-update A preserves startup defaults",
    initial: CONFIG_A,
    request: { model: "a-target" },
    controls: [configCall("a-target")],
    expected: success,
  },
  {
    name: "valid B setter rejection prevents the prompt",
    initial: CONFIG_A,
    duringCapture: [owned(B)],
    request: { model: "b-target" },
    rejectSetter: "valid-setter-rejected",
    controls: [configCall("b-target")],
    expected: { kind: "adapter", sentinel: "valid-setter-rejected" },
  },
  {
    name: "foreign model history cannot suppress legacy seeding",
    initial: LEGACY_L,
    duringCapture: [{ sessionId: FOREIGN_ID, configOptions: B }, owned([])],
    request: { model: "l-target" },
    controls: [legacyCall("l-target")],
    expected: success,
  },
];

// The peer does not decide whether any selector is supported. Unless a literal
// rejection is configured, even an erroneous legacy setter is accepted and logged.
const PEER = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const [directory] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(path.join(directory, "fixture.json"), "utf8"));
const journal = path.join(directory, "peer.jsonl");
let sequence = 0;
const log = (entry) => appendFileSync(journal,
  JSON.stringify({ pid: process.pid, sequence: ++sequence, ...entry }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let configOptions = fixture.initial.configOptions ?? [];
let inputClosed = false;
const input = readline.createInterface({ input: process.stdin });
input.once("close", () => { inputClosed = true; });
async function marker(name) {
  while (!inputClosed && !existsSync(path.join(directory, name))) await delay(5);
  return !inputClosed;
}
function publish(update, phase, index) {
  log({ kind: "update", phase, index, update });
  send({ method: "session/update", params: {
    sessionId: update.sessionId,
    update: { sessionUpdate: "config_option_update", configOptions: update.configOptions },
  } });
  if (update.sessionId === fixture.initial.sessionId) configOptions = update.configOptions;
}
log({ kind: "started" });
async function handle({ id, method, params }) {
  log({ kind: "request", method, params });
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    for (const [index, update] of fixture.beforeResponse.entries()) {
      publish(update, "before-response", index);
      if (!(await marker("ack-before-response-" + index))) return;
    }
    configOptions = fixture.initial.configOptions ?? [];
    log({ kind: "new-response", response: fixture.initial });
    send({ id, result: fixture.initial });
    for (const [index, update] of fixture.duringCapture.entries()) {
      if (!(await marker("publish-capture-" + index))) return;
      publish(update, "capture", index);
    }
  } else if (method === "session/set_config_option" || method === "session/set_model") {
    if (fixture.rejectSetter) {
      const error = { code: -32602, message: fixture.errorMessage,
        data: { fixture: fixture.rejectSetter } };
      log({ kind: "rejected", method, params, error });
      send({ id, error });
      return;
    }
    log({ kind: "accepted", method, params });
    if (method === "session/set_config_option") {
      configOptions = configOptions.map((option) => option.id === params.configId
        ? { ...option, currentValue: params.value } : option);
      send({ id, result: { configOptions } });
    } else {
      send({ id, result: {} });
    }
  } else if (method === "session/prompt") {
    send({ id, result: { stopReason: "end_turn" } });
  }
}
input.on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
    input.close();
  });
});
`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withinDeadline<T>(
  pending: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type PeerEntry = {
  pid: number;
  sequence: number;
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
  response?: InitialResponse;
  update?: ConfigUpdate;
  phase?: string;
  index?: number;
  error?: { code: number; message: string; data: { fixture: string } };
};
type Outcome =
  | { ok: true; value: Awaited<ReturnType<typeof runOnce>> }
  | { ok: false; error: unknown };

async function readEntries(directory: string): Promise<PeerEntry[]> {
  return (await fs.readFile(path.join(directory, "peer.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PeerEntry);
}

function controlCalls(entries: PeerEntry[], kind: string) {
  return entries
    .filter(
      (entry) =>
        entry.kind === kind &&
        (entry.method === "session/set_config_option" || entry.method === "session/set_model"),
    )
    .map(({ method, params }) => ({ method, params }));
}

function assertOutcome(outcome: Outcome, expected: ExpectedOutcome): void {
  if (expected.kind === "success") {
    if (!outcome.ok) {
      throw outcome.error;
    }
    assert.equal(outcome.value.stopReason, "end_turn");
    assert.equal(outcome.value.sessionId, SESSION_ID);
    return;
  }
  assert.equal(outcome.ok, false, "expected execution to fail before prompting");
  if (outcome.ok) {
    return;
  }
  if (expected.kind === "local") {
    assert.ok(isRequestedModelUnsupportedError(outcome.error));
    assert.equal(outcome.error.code, "ACP_MODEL_UNSUPPORTED");
    assert.equal(outcome.error.reason, expected.reason);
    assert.equal(extractAcpError(outcome.error), undefined);
    return;
  }
  assert.equal(isRequestedModelUnsupportedError(outcome.error), false);
  const acp = extractAcpError(outcome.error);
  assert.equal(acp?.code, -32602);
  assert.equal(acp?.message, ADAPTER_ERROR_MESSAGE);
  assert.deepEqual(acp?.data, { fixture: expected.sentinel });
}

function installCreationGate(t: TestContext) {
  const captureHeld = deferred<void>();
  const releaseCapture = deferred<void>();
  const snapshots: SessionCreateResult[] = [];
  const trace: string[] = [];
  let creating = false;
  let held = false;
  const createSession = AcpClient.prototype.createSession;
  t.mock.method(
    AcpClient.prototype,
    "createSession",
    async function (this: AcpClient, ...args: Parameters<typeof createSession>) {
      assert.equal(creating, false);
      creating = true;
      try {
        const result = await createSession.apply(this, args);
        snapshots.push(result);
        trace.push("creation-returned");
        return result;
      } finally {
        creating = false;
      }
    },
  );
  const capture = ProcessDescendants.prototype.capture;
  t.mock.method(
    ProcessDescendants.prototype,
    "capture",
    async function (this: ProcessDescendants, ...args: Parameters<typeof capture>) {
      const holdThisCapture = creating && !held;
      if (holdThisCapture) {
        held = true;
      }
      const result = await capture.apply(this, args);
      if (holdThisCapture) {
        trace.push("capture-held");
        captureHeld.resolve(undefined);
        await releaseCapture.promise;
        trace.push("capture-returned");
      }
      return result;
    },
  );
  return { captureHeld, releaseCapture, snapshots, trace, held: () => held };
}

function assertNotification(notification: SessionNotification, expected: ConfigUpdate): void {
  assert.equal(notification.sessionId, expected.sessionId);
  assert.equal(notification.update.sessionUpdate, "config_option_update");
  if (notification.update.sessionUpdate === "config_option_update") {
    assert.deepEqual(notification.update.configOptions, expected.configOptions);
  }
}

async function runScenario(t: TestContext, scenario: Scenario): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-create-catalog-"));
  const peer = path.join(directory, "peer.mjs");
  const beforeResponse = scenario.beforeResponse ?? [];
  const duringCapture = scenario.duringCapture ?? [];
  const expectedUpdates = [...beforeResponse, ...duringCapture];
  // Deliberately omit expected outcomes/control RPCs from the peer's inputs.
  await fs.writeFile(
    path.join(directory, "fixture.json"),
    JSON.stringify({
      initial: scenario.initial,
      beforeResponse,
      duringCapture,
      rejectSetter: scenario.rejectSetter,
      errorMessage: ADAPTER_ERROR_MESSAGE,
    }),
  );
  await fs.writeFile(peer, PEER);
  await fs.writeFile(path.join(directory, "peer.jsonl"), "");
  const gate = installCreationGate(t);
  const notifications = expectedUpdates.map(() => deferred<SessionNotification>());
  const delivered: SessionNotification[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  const releaseOnAbort = () => gate.releaseCapture.resolve(undefined);
  signal.addEventListener("abort", releaseOnAbort, { once: true });
  const selection =
    "model" in scenario.request
      ? { sessionOptions: { model: scenario.request.model } }
      : { configOptions: [{ configId: "llm", value: scenario.request.config }] };
  const running: Promise<Outcome> = runOnce(
    {
      ...normalizeAgentCommandInput([process.execPath, peer, directory]),
      cwd: directory,
      prompt: [{ type: "text", text: "synthetic catalog ordering proof" }],
      permissionMode: "deny-all",
      outputFormatter: DISCARD_OUTPUT_FORMATTER,
      promptRetries: 0,
      ...selection,
      onSessionUpdate(notification) {
        if (notification.update.sessionUpdate !== "config_option_update") {
          return;
        }
        const index = delivered.length;
        const receipt = structuredClone(notification);
        delivered.push(receipt);
        gate.trace.push(`callback:${index}`);
        notifications[index]?.resolve(receipt);
      },
    },
    { signal, handleProcessInterrupts: false },
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const earlyTermination = running.then((outcome): never => {
    if (!outcome.ok) {
      throw outcome.error;
    }
    throw new Error("runOnce completed before the required creation barrier");
  });
  const awaitNotification = (index: number, timeoutMs = 5_000) =>
    withinDeadline(
      Promise.race([notifications[index].promise, earlyTermination]),
      `callback ${index}`,
      timeoutMs,
    );

  let settledOutcome: Outcome | undefined;
  let failed = false;
  let failure: unknown;
  try {
    for (const [index, expected] of beforeResponse.entries()) {
      // The first pre-response update also waits for process startup/initial capture.
      assertNotification(await awaitNotification(index, index === 0 ? 25_000 : 5_000), expected);
      assert.equal(gate.held(), false);
      assert.equal(gate.snapshots.length, 0);
      assert.equal(
        (await readEntries(directory)).some((entry) => entry.kind === "new-response"),
        false,
        "peer must not send A until the actual callback is acknowledged",
      );
      await fs.writeFile(path.join(directory, `ack-before-response-${index}`), "observed");
    }
    // With no pre-response update, this includes both real eight-second capture budgets.
    await withinDeadline(
      Promise.race([gate.captureHeld.promise, earlyTermination]),
      "creation capture",
      25_000,
    );
    assert.equal(gate.snapshots.length, 0);
    for (const [index, expected] of duringCapture.entries()) {
      await fs.writeFile(path.join(directory, `publish-capture-${index}`), "publish");
      assertNotification(await awaitNotification(beforeResponse.length + index), expected);
      assert.equal(gate.snapshots.length, 0, "creation must still be held after callback delivery");
    }
    gate.releaseCapture.resolve(undefined);
    settledOutcome = await withinDeadline(running, "runOnce completion", 15_000);
    const entries = await readEntries(directory);
    t.diagnostic(
      JSON.stringify({
        scenario: scenario.name,
        trace: gate.trace,
        snapshots: gate.snapshots,
        delivered,
        entries,
        outcome: settledOutcome.ok
          ? { ok: true, value: settledOutcome.value }
          : {
              ok: false,
              name:
                settledOutcome.error instanceof Error
                  ? settledOutcome.error.name
                  : typeof settledOutcome.error,
              message:
                settledOutcome.error instanceof Error
                  ? settledOutcome.error.message
                  : String(settledOutcome.error),
              acp: extractAcpError(settledOutcome.error),
            },
      }),
    );
    assert.deepEqual(gate.trace, [
      ...beforeResponse.map((_, index) => `callback:${index}`),
      "capture-held",
      ...duringCapture.map((_, index) => `callback:${beforeResponse.length + index}`),
      "capture-returned",
      "creation-returned",
    ]);
    assert.equal(gate.snapshots.length, 1);
    assert.equal(gate.snapshots[0]?.sessionId, SESSION_ID);
    assert.deepEqual(gate.snapshots[0]?.configOptions, scenario.initial.configOptions);
    if (scenario.initial.models) {
      assert.deepEqual(gate.snapshots[0]?.models, scenario.initial.models);
    }
    assert.equal(delivered.length, expectedUpdates.length);
    assert.equal(entries.filter((entry) => entry.kind === "started").length, 1);
    assert.deepEqual(
      entries.filter((entry) => entry.kind === "new-response").map((entry) => entry.response),
      [scenario.initial],
    );
    assert.deepEqual(
      entries
        .filter((entry) => entry.kind === "update")
        .map(({ phase, index, update }) => ({ phase, index, update })),
      [
        ...beforeResponse.map((update, index) => ({ phase: "before-response", index, update })),
        ...duringCapture.map((update, index) => ({ phase: "capture", index, update })),
      ],
    );
    // Count received requests before accepting any outcome. In particular, the
    // permissive peer cannot hide a leaked legacy setter behind its own rejection.
    assert.deepEqual(controlCalls(entries, "request"), scenario.controls);
    assert.deepEqual(
      controlCalls(entries, "accepted"),
      scenario.rejectSetter ? [] : scenario.controls,
    );
    assert.deepEqual(
      controlCalls(entries, "rejected"),
      scenario.rejectSetter ? scenario.controls : [],
    );
    const prompts = entries.filter(
      (entry) => entry.kind === "request" && entry.method === "session/prompt",
    );
    assert.equal(prompts.length, scenario.expected.kind === "success" ? 1 : 0);
    for (const prompt of prompts) {
      assert.equal(prompt.params?.sessionId, SESSION_ID);
      assert.deepEqual(prompt.params?.prompt, [
        { type: "text", text: "synthetic catalog ordering proof" },
      ]);
    }
    const methods = entries
      .filter(
        (entry) =>
          entry.kind === "request" &&
          [
            "session/new",
            "session/set_config_option",
            "session/set_model",
            "session/prompt",
          ].includes(entry.method ?? ""),
      )
      .map((entry) => entry.method);
    assert.deepEqual(methods, [
      "session/new",
      ...scenario.controls.map((entry) => entry.method),
      ...(scenario.expected.kind === "success" ? ["session/prompt"] : []),
    ]);
    assertOutcome(settledOutcome, scenario.expected);
  } catch (error) {
    failed = true;
    failure = error;
  }

  gate.releaseCapture.resolve(undefined);
  const cleanupReason = new Error("Synthetic catalog test cleanup");
  controller.abort(cleanupReason);
  const cleanupErrors: unknown[] = [];
  try {
    // Cancellation may consume 2.5s before the separate 8s client cleanup budget.
    const outcome = await withinDeadline(running, "runOnce owned retirement", 15_000);
    const inspectedError = settledOutcome && !settledOutcome.ok ? settledOutcome.error : undefined;
    if (
      !outcome.ok &&
      outcome.error !== inspectedError &&
      outcome.error !== failure &&
      outcome.error !== cleanupReason &&
      outcome.error !== t.signal.reason
    ) {
      cleanupErrors.push(outcome.error);
    }
    const entries = await readEntries(directory);
    if (!settledOutcome) {
      t.diagnostic(
        JSON.stringify({
          scenario: scenario.name,
          prerequisiteFailed: true,
          trace: gate.trace,
          snapshots: gate.snapshots,
          delivered,
          entries,
        }),
      );
    }
    const pids = new Set(
      entries.filter((entry) => entry.kind === "started").map((entry) => entry.pid),
    );
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    if (cleanupErrors.length === 0) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    signal.removeEventListener("abort", releaseOnAbort);
  }
  if (cleanupErrors.length > 0) {
    t.diagnostic(`Incomplete fixture cleanup; retained ${directory}`);
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Catalog fixture cleanup failed",
      { cause: failed ? failure : cleanupErrors[0] },
    );
  }
  if (failed) {
    throw failure;
  }
}

// These tests patch only a scheduling seam and must not overlap in this process.
for (const scenario of SCENARIOS) {
  test(
    `runOnce catalog: ${scenario.name}`,
    { timeout: 90_000, concurrency: false },
    async (t) => await runScenario(t, scenario),
  );
}
