import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProcessBirthIdentity } from "../src/process-identity.js";
import {
  interruptCases,
  interruptDefinition,
  sendInterrupt,
  verifyInterrupt,
  writeInterruptWitness,
  type InterruptCase,
} from "./conformance-interrupt-test-helpers.js";
import {
  nativeState,
  readReady,
  receipts,
  rescue,
  stopped,
  until,
} from "./conformance-retirement-test-helpers.js";
import {
  verifySlowTableBudget,
  writeSlowTablePreload,
} from "./conformance-snapshot-test-helpers.js";
import { parseReport, REPO_ROOT } from "./conformance-test-helpers.js";
import type { Mode, Ready } from "./fixtures/conformance-retirement.js";

const fixture = fileURLToPath(new URL("./fixtures/conformance-retirement.js", import.meta.url));
type Exit = { code: number | null; signal: NodeJS.Signals | null; at: number };

async function writeRetirementFailurePreload(root: string, nonce: string): Promise<string> {
  const preloadPath = path.join(root, "retirement-failure-preload.mjs");
  const tracePath = path.join(root, "retirement-failure.ndjson");
  const runnerPath = path.join(REPO_ROOT, "conformance/runner/run.ts");
  const lifetimeUrl = pathToFileURL(
    path.join(REPO_ROOT, "conformance/runner/adapter-lifetime.ts"),
  ).href;
  // Resolve from the real test module, never relative to a tempfile outside node_modules.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  await fs.writeFile(
    preloadPath,
    `
import { appendFileSync } from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  if (path.resolve(process.argv[1] ?? "") !== ${JSON.stringify(runnerPath)}) {
    throw new Error("F5 test preload attached to an unexpected entry point");
  }
  const nonce = ${JSON.stringify(nonce)};
  const tracePath = ${JSON.stringify(tracePath)};
  const record = (entry) => appendFileSync(tracePath,
    JSON.stringify({ nonce, pid: process.pid, ...entry }) + "\\n");
  const { register } = await import(${JSON.stringify(tsxApiUrl)});
  // No tsImport(), namespace, alternate build tree or second tsx registration.
  register({ tsconfig: ${JSON.stringify(path.join(REPO_ROOT, "tsconfig.json"))} });
  const { AdapterLifetime } = await import(${JSON.stringify(lifetimeUrl)});
  const realWaitForRetirement = AdapterLifetime.prototype.waitForRetirement;
  const owners = new WeakMap();
  let nextOwner = 0;
  let nextCall = 0;
  AdapterLifetime.prototype.waitForRetirement = async function (...args) {
    const timeoutMs = args[0];
    let owner = owners.get(this);
    if (owner === undefined) { owner = ++nextOwner; owners.set(this, owner); }
    const call = ++nextCall;
    let actual;
    try {
      // Do not bypass native snapshots, waits, TERM/KILL or their actual outcome.
      actual = await Reflect.apply(realWaitForRetirement, this, args);
    } catch (error) {
      record({ kind: "wait-threw", owner, call, timeoutMs, error: String(error) });
      throw error;
    }
    record({ kind: "wait-return", owner, call, timeoutMs, actual, returned: false });
    return false;
  };
  record({ kind: "installed", module: ${JSON.stringify(lifetimeUrl)} });
}
`,
    "utf8",
  );
  return pathToFileURL(preloadPath).href;
}

async function retirementCase(
  t: TestContext,
  mode: Mode,
  retirementFault?: "initialization" | "body",
  interrupt?: InterruptCase,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-retirement-"));
  const nonce = randomUUID();
  const direct = mode === "direct" || mode === "eof";
  const casesDir = path.join(root, "cases");
  const profile = path.join(root, "profile.json");
  const reportPath = path.join(root, "report.json");
  const id = `synthetic.retirement.${interrupt?.scenario ?? mode}`;
  await fs.mkdir(casesDir);
  const laterId = "synthetic.retirement.must-not-launch";
  await fs.writeFile(
    profile,
    JSON.stringify({
      id: "synthetic-retirement",
      required_cases: retirementFault || interrupt ? [id, laterId] : [id],
    }),
  );
  if (retirementFault || interrupt) {
    await fs.writeFile(
      path.join(casesDir, "later.json"),
      JSON.stringify({
        id: laterId,
        steps: [],
        checks: [{ type: "initialize_protocol_version_number" }],
      }),
    );
  }
  await fs.writeFile(
    path.join(casesDir, "case.json"),
    JSON.stringify({
      id,
      steps:
        mode === "prompt-timeout"
          ? [
              { action: "new_session", save_as: "session" },
              {
                action: "prompt",
                session: "$session",
                prompt: [{ type: "text", text: "synthetic silent prompt" }],
              },
            ]
          : [],
      checks:
        retirementFault === "body"
          ? [{ type: "saved_non_empty_string", key: "synthetic_missing_body_marker" }]
          : [{ type: "initialize_protocol_version_number" }],
      timeouts: { update_timeout_ms: 250 },
      ...(interrupt ? interruptDefinition(interrupt) : {}),
    }),
  );
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    NODE_V8_COVERAGE: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=DEP0205`.trim(),
  };
  const command = [process.execPath, fixture, root, nonce, direct ? "peer" : "wrapper", mode]
    .map((arg) => JSON.stringify(arg))
    .join(" ");
  const runner = spawn(
    process.execPath,
    [
      "--import",
      retirementFault
        ? await writeRetirementFailurePreload(root, nonce)
        : interrupt
          ? await writeInterruptWitness(root, nonce)
          : mode === "eof"
            ? await writeSlowTablePreload(root, nonce)
            : "tsx",
      path.join(REPO_ROOT, "conformance/runner/run.ts"),
      "--profile",
      profile,
      "--cases-dir",
      casesDir,
      "--cwd",
      root,
      "--agent-command",
      command,
      "--format",
      "json",
      "--report",
      reportPath,
    ],
    { cwd: REPO_ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const observed: {
    exit?: Exit;
    close?: Exit;
    stdoutEof?: number;
    stderrEof?: number;
    spawnError?: Error;
    stdout: string;
    stderr: string;
    pipeErrors: string[];
  } = { stdout: "", stderr: "", pipeErrors: [] };
  runner.stdout.setEncoding("utf8");
  runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", (chunk: string) => {
    observed.stdout += chunk;
  });
  runner.stderr.on("data", (chunk: string) => {
    observed.stderr += chunk;
  });
  runner.stdout.on("error", (error: Error) => {
    observed.pipeErrors.push(`stdout: ${error.message}`);
  });
  runner.stderr.on("error", (error: Error) => {
    observed.pipeErrors.push(`stderr: ${error.message}`);
  });
  runner.stdout.once("end", () => {
    observed.stdoutEof = Date.now();
  });
  runner.stderr.once("end", () => {
    observed.stderrEof = Date.now();
  });
  runner.once("error", (error) => {
    observed.spawnError = error;
  });
  runner.once("exit", (code, signal) => {
    observed.exit = { code, signal, at: Date.now() };
  });
  runner.once("close", (code, signal) => {
    observed.close = { code, signal, at: Date.now() };
  });
  // This sibling is launched by the controller, never by the adapter's owner.
  const sibling = spawn(process.execPath, [fixture, root, nonce, "sibling", mode], {
    cwd: root,
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
  const siblingState: { closed: boolean; error?: Error } = { closed: false };
  sibling.once("close", () => {
    siblingState.closed = true;
  });
  sibling.once("error", (error) => {
    siblingState.error = error;
  });
  const joined = () =>
    Boolean(observed.exit && observed.close && observed.stdoutEof && observed.stderrEof);
  const roles = direct ? ["peer", "sibling"] : ["wrapper", "peer", "sibling"];
  const owned = new Map<string, Ready>();
  const notes: Array<{ name: string; at: number; detail?: unknown }> = [];
  const note = (name: string, detail?: unknown) => notes.push({ name, at: Date.now(), detail });
  const remember = async (role: string) => {
    const value = owned.get(role) ?? (await readReady(root, role, nonce));
    if (value) {
      owned.set(role, value);
    }
    return value;
  };
  let failed = false;
  let failure: unknown;
  try {
    // Initialization has the runner's existing 10s deadline. Do not gate it for 30s.
    await until("wrapper, peer and sibling readiness", 6_000, async () => {
      if (observed.spawnError) {
        throw observed.spawnError;
      }
      if (siblingState.error) {
        throw siblingState.error;
      }
      assert.equal(observed.exit, undefined, observed.stderr);
      const ready = await Promise.all(roles.map(remember));
      if (!ready.every(Boolean)) {
        return undefined;
      }
      if (mode === "wrapper-exited") {
        const rows = await receipts(root, "wrapper", nonce);
        if (
          !rows.some((row) => row.kind === "planned-wrapper-exit") ||
          !stopped(await nativeState(owned.get("wrapper")!))
        ) {
          return undefined;
        }
      }
      return true;
    });
    const admitted = await Promise.all(
      roles.map(async (role) => ({ role, state: await nativeState(owned.get(role)!) })),
    );
    for (const value of admitted) {
      assert.equal(
        mode === "wrapper-exited" && value.role === "wrapper"
          ? stopped(value.state)
          : value.state === "matching",
        true,
        `${value.role} unexpected admission state: ${value.state}`,
      );
    }
    note("admission", admitted);
    if (mode === "wrapper-exited") {
      assert.equal(
        (await receipts(root, "peer", nonce)).some((row) => row.kind === "reply-attempt"),
        false,
      );
      note("wrapper-retired-before-reply");
    }
    await fs.writeFile(path.join(root, "admit"), nonce);
    if (interrupt) {
      await sendInterrupt({
        root,
        nonce,
        runner,
        interrupt,
        note,
        assertRunning: () => assert.equal(observed.exit, undefined, observed.stderr),
      });
    }

    // No rescue has run, and the fixture's 90s emergency is well beyond this bound.
    await until("runner natural exit, close and both real pipe EOFs", 12_000, async () =>
      joined() ? true : undefined,
    );
    const expectedCode =
      retirementFault || interrupt || mode === "init-error" || mode === "prompt-timeout" ? 1 : 0;
    assert.equal(observed.exit?.code, interrupt ? null : expectedCode, observed.stderr);
    assert.equal(observed.exit?.signal, interrupt?.signal ?? null);
    assert.equal(observed.close?.code, interrupt ? null : expectedCode);
    assert.equal(observed.close?.signal, interrupt?.signal ?? null);
    assert.deepEqual(observed.pipeErrors, []);
    const report = parseReport(observed.stdout);
    assert.deepEqual(parseReport(await fs.readFile(reportPath, "utf8")), report);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: expectedCode === 0 ? 1 : 0,
      failed: expectedCode,
    });
    assert.equal(report.results[0]?.id, id);
    if (interrupt) {
      const diagnostic = report.results[0]?.error ?? "";
      assert.match(diagnostic, /interrupted|aborted/i);
      assert.doesNotMatch(diagnostic, /timed out|Adapter cleanup failed/i);
      if (interrupt.scenario === "initialize") {
        assert.match(diagnostic, /initialize failed:/);
      }
      for (const role of ["wrapper", "peer"]) {
        const boots = (await receipts(root, role, nonce)).filter((row) => row.kind === "ready");
        assert.equal(boots.length, 1, `${role}: no later case may launch`);
        assert.equal(boots[0].pid, owned.get(role)?.pid);
      }
      note("interrupt-witness", await verifyInterrupt(root, nonce, runner.pid, interrupt));
    } else if (retirementFault) {
      assert.deepEqual(
        report.results.map((result) => result.id),
        [id],
      );
      const diagnostic = report.results[0]?.error ?? "";
      assert.match(
        diagnostic,
        /Adapter cleanup failed: Adapter process retirement could not be verified/,
      );
      assert.match(diagnostic, /\nCleanup: /);
      assert.match(
        diagnostic,
        retirementFault === "initialization"
          ? /synthetic F5 initialize rejection/
          : /saved\.synthetic_missing_body_marker must be a non-empty string/,
      );
      type FaultRow = {
        nonce: string;
        pid: number;
        kind: string;
        owner?: number;
        actual?: boolean;
        returned?: boolean;
      };
      const faultRows = (await fs.readFile(path.join(root, "retirement-failure.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FaultRow);
      assert.equal(faultRows.filter((row) => row.kind === "installed").length, 1);
      for (const row of faultRows) {
        assert.equal(row.nonce, nonce);
        assert.equal(row.pid, runner.pid);
      }
      assert.equal(
        faultRows.some((row) => row.kind === "wait-threw"),
        false,
      );
      const waits = faultRows.filter((row) => row.kind === "wait-return");
      assert.ok(waits.length > 0, "the actual source owner must receive the fault");
      assert.deepEqual([...new Set(waits.map((row) => row.owner))], [1]);
      assert.ok(waits.every((row) => row.returned === false));
      assert.equal(waits.at(-1)?.actual, true, "real retirement must precede injected uncertainty");
      note("retirement-fault", faultRows);
      for (const role of ["wrapper", "peer"]) {
        const boots = (await receipts(root, role, nonce)).filter((row) => row.kind === "ready");
        assert.equal(boots.length, 1, `${role}: unexpected later adapter launch`);
        assert.equal(boots[0].pid, owned.get(role)?.pid);
      }
    } else if (mode === "init-error") {
      assert.match(report.results[0]?.error ?? "", /synthetic F5 initialize rejection/);
    } else if (mode === "prompt-timeout") {
      assert.match(report.results[0]?.error ?? "", /session\/prompt timed out after 250ms/);
    } else {
      assert.equal(report.results[0]?.error, undefined);
    }

    const peerRows = await receipts(root, "peer", nonce);
    note("peer-protocol-receipts", peerRows);
    const requests = peerRows
      .filter((row) => row.kind === "request")
      .map((row) => {
        assert.ok(row.detail && typeof row.detail === "object" && "line" in row.detail);
        assert.equal(typeof row.detail.line, "string");
        return JSON.parse(row.detail.line as string) as { id: string | number; method: string };
      });
    assert.deepEqual(
      requests.map((row) => row.method),
      mode === "prompt-timeout" ? ["initialize", "session/new", "session/prompt"] : ["initialize"],
    );
    assert.deepEqual(
      peerRows.find((row) => row.kind === "reply-written")?.detail,
      mode === "init-wait"
        ? undefined
        : mode === "init-error"
          ? {
              id: requests[0].id,
              error: { code: -32077, message: "synthetic F5 initialize rejection" },
            }
          : { id: requests[0].id, result: { protocolVersion: 1, agentCapabilities: {} } },
    );
    if (mode === "prompt-timeout") {
      assert.ok(peerRows.some((row) => row.kind === "prompt-deliberately-unanswered"));
      assert.equal(
        peerRows.some(
          (row) =>
            row.kind === "reply-written" &&
            (row.detail as { id?: unknown }).id === requests.at(-1)?.id,
        ),
        false,
      );
    }
    if (mode === "ignore-term") {
      assert.ok(
        peerRows.some((row) => row.kind === "sigterm"),
        "actual descendant must observe TERM",
      );
      assert.equal(
        peerRows.some((row) => row.kind === "exit"),
        false,
        "TERM-resistant peer must not voluntarily exit",
      );
    }
    if (mode === "cooperative") {
      assert.ok(
        peerRows.some((row) => row.kind === "cooperative-cleanup-complete"),
        "descendant must finish cooperative cleanup after its wrapper exits",
      );
      assert.equal(
        peerRows.some((row) => row.kind === "sigterm"),
        false,
        "EOF grace applies to the witnessed descendant too",
      );
      assert.ok(
        (await receipts(root, "wrapper", nonce)).some((row) => row.kind === "planned-wrapper-exit"),
      );
    }
    if (mode === "eof") {
      note(
        "slow-table-budget-witness",
        await verifySlowTableBudget(root, nonce, runner.pid, peerRows),
      );
    }
    for (const role of roles) {
      const rows = await receipts(root, role, nonce);
      assert.equal(
        rows.some((row) => ["emergency", "rescue-stop", "fixture-error"].includes(row.kind)),
        false,
      );
      const state = await nativeState(owned.get(role)!);
      assert.equal(
        role === "sibling" ? state === "matching" : stopped(state),
        true,
        `${role}: ${state}`,
      );
    }
    assert.equal(siblingState.closed, false, "unrelated sibling must outlive runner cleanup");
    note("proof-passed-before-rescue", { ...observed });
  } catch (error) {
    failed = true;
    failure = error;
  }

  // One cleanup lane, including partial startup. Record native state before touching fixtures.
  const cleanupErrors: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  const before: Record<string, unknown> = {};
  for (const role of roles) {
    await attempt(async () => {
      const value = await remember(role);
      before[role] = value
        ? { identity: value, state: await nativeState(value) }
        : { ready: false };
    });
  }
  note("pre-rescue", { ...observed, processes: before });
  const witnessed = new Map<string, Ready>();
  for (const role of ["wrapper", "peer"]) {
    await attempt(async () => {
      for (const row of await receipts(root, role, nonce)) {
        if (row.kind !== "ready") {
          continue;
        }
        assert.ok(row.detail && typeof row.detail === "object" && "birth" in row.detail);
        const birth = parseProcessBirthIdentity(row.detail.birth);
        assert.ok(birth);
        const ready = { nonce, pid: row.pid, birth };
        witnessed.set(JSON.stringify([row.pid, birth]), ready);
      }
    });
  }
  await attempt(async () => {
    await fs.writeFile(
      path.join(root, "pre-rescue.json"),
      JSON.stringify({ mode, nonce, notes }, null, 2),
    );
  });
  await attempt(async () => {
    await fs.writeFile(path.join(root, "stop"), nonce);
    note("cooperative-stop");
  });
  // Give the private marker a chance to stop even a peer not yet done publishing readiness.
  await attempt(async () => {
    await until("fixture cooperative stop", 2_000, async () => {
      const states = await Promise.all([...owned.values()].map(nativeState));
      return states.every(stopped) ? true : undefined;
    });
  });
  // Timeout above remains a cleanup diagnostic; rescue never turns a failed proof into a pass.
  for (const role of ["peer", "wrapper"]) {
    await attempt(async () => {
      const value = await remember(role);
      if (value) {
        await rescue(value);
      } else if (role !== "wrapper" || !direct) {
        const peerSpawned = (await receipts(root, "wrapper", nonce)).some(
          (row) => row.kind === "peer-spawned",
        );
        assert.equal(
          peerSpawned,
          false,
          `missing ${role} identity after peer launch; preserve for recovery`,
        );
      }
    });
  }
  for (const identity of witnessed.values()) {
    await attempt(async () => {
      await rescue(identity);
    });
  }
  await attempt(async () => {
    if (!siblingState.closed) {
      sibling.kill("SIGKILL");
    } // Own unreaped ChildProcess, not a stored PID.
    await until("sibling close", 3_000, async () => (siblingState.closed ? true : undefined));
  });
  await attempt(async () => {
    if (!observed.exit && !observed.spawnError) {
      runner.kill("SIGKILL");
    }
    await until("runner rescue exit, close and real pipe EOFs", 5_000, async () =>
      joined() || (observed.spawnError && observed.close) ? true : undefined,
    );
  });
  // A failed join must not pin the test worker. These closures are NEVER EOF proof.
  if (!joined() && !(observed.spawnError && observed.close)) {
    note("controller-handle-retirement-after-failed-join");
    runner.stdout.destroy();
    runner.stderr.destroy();
    runner.unref();
  }
  if (!siblingState.closed) {
    sibling.unref();
  }
  for (const role of roles) {
    await attempt(async () => {
      assert.equal(
        (await receipts(root, role, nonce)).some((row) => row.kind === "emergency"),
        false,
        `${role} emergency fired`,
      );
    });
  }
  note("cleanup-completed", { ...observed, errors: cleanupErrors.map(String) });
  t.diagnostic(
    JSON.stringify({ mode, platform: process.platform, node: process.version, root, notes }),
  );
  // Preserve failed baseline/proof inputs and receipts even when rescue succeeded.
  if (!failed && cleanupErrors.length === 0) {
    await fs.rm(root, { recursive: true, force: true });
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      `Conformance fixture cleanup failed: ${root}`,
    );
  }
  if (failed) {
    throw failure;
  }
}

for (const interrupt of interruptCases) {
  test(
    `conformance joins cleanup after ${interrupt.scenario} interruption`,
    {
      timeout: 75_000,
      skip: process.platform === "win32",
    },
    async (t) => {
      await retirementCase(t, interrupt.mode, undefined, interrupt);
    },
  );
}

for (const mode of [
  "success",
  "ignore-term",
  "init-error",
  "prompt-timeout",
  "wrapper-exited",
  "cooperative",
  "eof",
  "direct",
] as const) {
  test(
    `conformance retires ${mode} adapter and its transport`,
    {
      timeout: 75_000,
      // TERM handlers and owned POSIX group admission are distinct platform claims.
      skip:
        (process.platform === "win32" && (mode === "ignore-term" || mode === "wrapper-exited")) ||
        (mode === "eof" && process.platform !== "darwin" && process.platform !== "linux"),
    },
    async (t) => {
      await retirementCase(t, mode);
    },
  );
}

for (const fault of ["initialization", "body"] as const) {
  test(
    `conformance preserves ${fault} and cleanup errors and stops later cases`,
    {
      timeout: 75_000,
    },
    async (t) => {
      await retirementCase(t, fault === "initialization" ? "init-error" : "success", fault);
    },
  );
}
