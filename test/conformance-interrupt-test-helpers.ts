import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { receipts, until } from "./conformance-retirement-test-helpers.js";
import { REPO_ROOT } from "./conformance-test-helpers.js";

export const interruptCases = [
  { scenario: "initialize", mode: "init-wait", signal: "SIGTERM" },
  { scenario: "prompt-expected-error", mode: "prompt-timeout", signal: "SIGINT" },
  { scenario: "sleep", mode: "success", signal: "SIGHUP" },
  { scenario: "settle", mode: "success", signal: "SIGTERM" },
  { scenario: "repeated", mode: "ignore-term", signal: "SIGINT" },
] as const;
export type InterruptCase = (typeof interruptCases)[number];

export function interruptDefinition(interrupt: InterruptCase) {
  const { scenario } = interrupt;
  const steps =
    scenario === "prompt-expected-error"
      ? [
          { action: "new_session", save_as: "session" },
          {
            action: "prompt",
            session: "$session",
            prompt: [{ type: "text", text: "synthetic silent prompt" }],
            expect_error: {},
          },
          { action: "new_session", save_as: "must_not_run_after_interruption" },
        ]
      : scenario === "sleep" || scenario === "repeated"
        ? [
            { action: "sleep", ms: 60_000 },
            { action: "new_session", save_as: "must_not_run_after_interruption" },
          ]
        : [];
  return {
    steps,
    timeouts: {
      update_timeout_ms: 60_000,
      ...(scenario === "settle" ? { settle_timeout_ms: 60_000 } : {}),
    },
  };
}

export async function writeInterruptWitness(root: string, nonce: string): Promise<string> {
  const file = path.join(root, "interrupt-witness.mjs");
  const trace = path.join(root, "interrupt-witness.ndjson");
  const runner = path.join(REPO_ROOT, "conformance/runner/run.ts");
  const descendants = pathToFileURL(path.join(REPO_ROOT, "src/acp/process-descendants.ts")).href;
  await fs.writeFile(
    file,
    `
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  if (path.resolve(process.argv[1] ?? "") !== ${JSON.stringify(runner)}) {
    throw new Error("F5 interrupt witness attached to unexpected entry point");
  }
  let sequence = 0;
  const record = (entry) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
    nonce: ${JSON.stringify(nonce)}, pid: process.pid, sequence: ++sequence,
    at: Date.now(), ...entry,
  }) + "\\n");

  // Observe dispatch without registering a listener that could accidentally
  // protect a broken once-handler implementation from the second signal.
  const emit = process.emit;
  process.emit = function (event, ...args) {
    if (["SIGINT", "SIGTERM", "SIGHUP"].includes(event)) {
      record({ kind: "signal-dispatch", signal: event });
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };

  const realDelay = timers.setTimeout;
  timers.setTimeout = function (...args) {
    const pending = Reflect.apply(realDelay, this, args);
    if (args[0] === 60_000) {
      const signal = args[2]?.signal;
      // Native API has returned its real promise; no fake timer or reduced delay.
      record({ kind: "delay-armed", ms: args[0], hasSignal: Boolean(signal), alreadyAborted: signal?.aborted ?? false });
      void pending.then(
        () => record({ kind: "delay-settled", outcome: "fulfilled" }),
        error => record({ kind: "delay-settled", outcome: "rejected", name: error?.name, code: error?.code,
          signalAborted: signal?.aborted ?? false, cause: String(error?.cause ?? "") }),
      );
    }
    return pending; // Preserve the original native promise, including its rejection.
  };
  syncBuiltinESMExports();

  const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
  register({ tsconfig: ${JSON.stringify(path.join(REPO_ROOT, "tsconfig.json"))} });
  const { ProcessDescendants } = await import(${JSON.stringify(descendants)});
  const realWait = ProcessDescendants.prototype.waitForExit;
  let call = 0;
  ProcessDescendants.prototype.waitForExit = function (...args) {
    const id = ++call;
    const pending = Reflect.apply(realWait, this, args);
    record({ kind: "cleanup-wait-enter", call: id, timeoutMs: args[0] });
    void pending.then(
      actual => record({ kind: "cleanup-wait-settled", call: id, actual }),
      error => record({ kind: "cleanup-wait-threw", call: id, error: String(error) }),
    );
    return pending; // No forced result, extra grace period, gate or cancellation.
  };
  record({ kind: "installed" });
}
`,
    "utf8",
  );
  return pathToFileURL(file).href;
}

export type InterruptWitness = {
  nonce: string;
  pid: number;
  sequence: number;
  kind: string;
  signal?: "SIGINT" | "SIGTERM" | "SIGHUP";
  call?: number;
  timeoutMs?: number;
  actual?: boolean;
  ms?: number;
  hasSignal?: boolean;
  alreadyAborted?: boolean;
  outcome?: "fulfilled" | "rejected";
  name?: string;
  code?: string;
  signalAborted?: boolean;
  cause?: string;
};

export async function readInterruptWitness(
  root: string,
  nonce: string,
): Promise<InterruptWitness[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "interrupt-witness.ndjson"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const row = JSON.parse(line) as InterruptWitness;
      assert.equal(row.nonce, nonce);
      return row;
    });
}

export async function sendInterrupt(params: {
  root: string;
  nonce: string;
  runner: ChildProcess;
  interrupt: InterruptCase;
  assertRunning: () => void;
  note: (name: string, detail?: unknown) => void;
}): Promise<void> {
  const { root, nonce, runner, interrupt, assertRunning, note } = params;
  const { scenario, signal } = interrupt;
  if (scenario === "initialize" || scenario === "prompt-expected-error") {
    const wanted =
      scenario === "initialize"
        ? "initialize-deliberately-unanswered"
        : "prompt-deliberately-unanswered";
    await until(wanted, 5_000, async () => {
      assertRunning();
      return (await receipts(root, "peer", nonce)).some((row) => row.kind === wanted)
        ? true
        : undefined;
    });
  } else {
    await until("actual long native delay armed", 5_000, async () => {
      assertRunning();
      const armed = (await readInterruptWitness(root, nonce)).find(
        (row) => row.kind === "delay-armed",
      );
      if (!armed) {
        return undefined;
      }
      assert.equal(armed.pid, runner.pid);
      assert.equal(armed.ms, 60_000);
      assert.equal(armed.hasSignal, true);
      assert.equal(armed.alreadyAborted, false);
      return true;
    });
  }
  note("first-signal-send", { signal });
  assert.equal(runner.kill(signal), true, "signal only the owned runner handle");
  if (scenario !== "repeated") {
    return;
  }
  await until("peer TERM receipt and pending first cleanup wait", 5_000, async () => {
    assertRunning();
    const peer = await receipts(root, "peer", nonce);
    const trace = await readInterruptWitness(root, nonce);
    const entered = trace.find(
      (row) => row.kind === "cleanup-wait-enter" && row.timeoutMs === 1_500,
    );
    const settled =
      entered &&
      trace.some(
        (row) =>
          row.call === entered.call &&
          ["cleanup-wait-settled", "cleanup-wait-threw"].includes(row.kind),
      );
    if (entered && !settled && peer.some((row) => row.kind === "sigterm")) {
      return true;
    }
    if (settled) {
      throw new Error("missed live TERM-wait window; repeat signal does not qualify");
    }
    return undefined;
  });
  note("second-signal-send", { signal: "SIGTERM" });
  assert.equal(runner.kill("SIGTERM"), true);
}

export async function verifyInterrupt(
  root: string,
  nonce: string,
  runnerPid: number | undefined,
  interrupt: InterruptCase,
): Promise<InterruptWitness[]> {
  const { scenario, signal } = interrupt;
  const trace = await readInterruptWitness(root, nonce);
  assert.equal(trace.filter((row) => row.kind === "installed").length, 1);
  for (const [index, row] of trace.entries()) {
    assert.equal(row.pid, runnerPid);
    assert.equal(row.sequence, index + 1);
  }
  assert.equal(trace.find((row) => row.kind === "signal-dispatch")?.signal, signal);
  assert.equal(
    trace.some((row) => row.kind === "cleanup-wait-threw"),
    false,
  );
  if (["sleep", "settle", "repeated"].includes(scenario)) {
    assert.equal(trace.filter((row) => row.kind === "delay-armed").length, 1);
    const cancelled = trace.find((row) => row.kind === "delay-settled");
    assert.ok(cancelled, "native timer must settle before the runner re-signals itself");
    assert.equal(cancelled.outcome, "rejected");
    assert.equal(cancelled.name, "AbortError");
    assert.equal(cancelled.code, "ABORT_ERR");
    assert.equal(cancelled.signalAborted, true);
    assert.match(cancelled.cause ?? "", new RegExp(signal));
  }
  if (scenario === "repeated") {
    const term = trace.find((row) => row.kind === "signal-dispatch" && row.signal === "SIGTERM");
    const wait = trace.find((row) => row.kind === "cleanup-wait-enter" && row.timeoutMs === 1_500);
    const finished =
      wait && trace.find((row) => row.kind === "cleanup-wait-settled" && row.call === wait.call);
    assert.ok(term && wait && finished);
    assert.ok(
      wait.sequence < term.sequence && term.sequence < finished.sequence,
      "second signal must dispatch during the first TERM cleanup wait",
    );
    assert.equal(finished.actual, false, "TERM-resistant peer must still need escalation");
  }
  return trace;
}
