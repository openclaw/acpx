import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// The normal test command builds dist before compiling/running test files.
const runtimeUrl = import.meta.resolve("acpx/runtime");
const mockAgentPath = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

const childProgram = String.raw`
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

const [scenario, runtimeUrl, seedJson] = process.argv.slice(1);
const { createAcpRuntime, AcpRuntimeError, decodeAcpxRuntimeHandleState } = await import(runtimeUrl);
const seed = JSON.parse(seedJson);
let launchAttempts = 0;
let saveAttempts = 0;
const runtime = createAcpRuntime({
  cwd: process.cwd(),
  permissionMode: "deny-all",
  agentRegistry: {
    resolve: () => "unused-deferred-agent",
    list: () => ["fixture"],
  },
  sessionStore: {
    load: async (id) => id === seed.acpxRecordId ? structuredClone(seed) : undefined,
    save: async () => {
      saveAttempts += 1;
      throw new Error("rejected admission must not save a session");
    },
  },
  processLifecycle: {
    onBeforeSpawn() {
      launchAttempts += 1;
      throw new Error("rejected admission must not launch an adapter");
    },
  },
});
let receipt;
try {
  const handle = await runtime.findSession({ sessionKey: seed.acpxRecordId, agent: "fixture" });
  assert.ok(handle, "public lookup must issue a handle for the seeded record");
  assert.equal(handle.acpxRecordId, seed.acpxRecordId);
  assert.ok(decodeAcpxRuntimeHandleState(handle.runtimeSessionName));
  if (scenario === "shutdown") {
    await runtime.shutdown();
  }
  const turn = runtime.startTurn({
    handle,
    text: "fixture",
    mode: "prompt",
    requestId: "deferred-" + scenario,
    ...(scenario === "admission"
      ? { attachments: [{ mediaType: "application/pdf", data: "Zml4dHVyZQ==" }] }
      : {}),
  });
  process.stdout.write(JSON.stringify({ phase: "turn-returned", scenario }) + "\n");

  // Do not read any lazy turn property until a later event-loop turn.
  await nextTurn();

  const code = scenario === "admission" ? "ACP_TURN_FAILED" : "ACP_BACKEND_UNAVAILABLE";
  const message = scenario === "admission"
    ? "Unsupported ACP runtime attachment media type: application/pdf"
    : "ACP runtime is shut down.";
  let originalError;
  await assert.rejects(turn.result, (error) => {
    assert.ok(error instanceof AcpRuntimeError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    originalError = error;
    return true;
  });
  await assert.rejects(turn.promptStarted, (error) => error === originalError);
  const iterator = turn.events[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error) => error === originalError);
  receipt = { phase: "verified", scenario, code, message, sameError: true };
} finally {
  await runtime.shutdown();
}
assert.equal(launchAttempts, 0);
assert.equal(saveAttempts, 0);
process.stdout.write(JSON.stringify({ ...receipt, launchAttempts, saveAttempts }) + "\n");
`;

for (const scenario of ["admission", "shutdown"] as const) {
  test(`built runtime retains delayed ${scenario} rejection without crashing the host`, (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-deferred-turn-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const seed = makeSessionRecord({
      acpxRecordId: "deferred-fixture",
      acpSessionId: "synthetic-backend",
      agentCommand: "unused-deferred-agent",
      cwd: directory,
    });
    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : {}),
    };
    const result = spawnSync(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--input-type=module",
        "--eval",
        childProgram,
        scenario,
        runtimeUrl,
        JSON.stringify(seed),
      ],
      { cwd: directory, env, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipts = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(receipts, [
      { phase: "turn-returned", scenario },
      {
        phase: "verified",
        scenario,
        code: scenario === "admission" ? "ACP_TURN_FAILED" : "ACP_BACKEND_UNAVAILABLE",
        message:
          scenario === "admission"
            ? "Unsupported ACP runtime attachment media type: application/pdf"
            : "ACP runtime is shut down.",
        sameError: true,
        launchAttempts: 0,
        saveAttempts: 0,
      },
    ]);
  });
}

test(
  "built runtime still completes an accepted turn observed on a later tick",
  { timeout: 30_000 },
  async (t) => {
    const { createAcpRuntime, createAgentRegistry, createFileSessionStore } =
      await import("acpx/runtime");
    const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-deferred-control-"));
    let launches = 0;
    const runtime = createAcpRuntime({
      cwd: directory,
      sessionStore: createFileSessionStore({ stateDir: path.join(directory, "state") }),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, mockAgentPath] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 10_000,
      processLifecycle: {
        onSpawned: () => {
          launches += 1;
        },
      },
    });
    t.after(async () => {
      await runtime.shutdown();
      rmSync(directory, { recursive: true, force: true });
    });
    const handle = await runtime.ensureSession({
      sessionKey: "deferred-control",
      agent: "fixture",
      mode: "oneshot",
    });
    const turn = runtime.startTurn({
      handle,
      text: "echo delayed public control",
      mode: "prompt",
      requestId: "deferred-control",
      timeoutMs: 10_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await turn.promptStarted;
    let output = "";
    for await (const event of turn.events) {
      if (event.type === "text_delta") {
        output += event.text;
      }
    }
    assert.deepEqual(await turn.result, { status: "completed", stopReason: "end_turn" });
    assert.equal(output, "delayed public control");
    assert.equal(launches, 1);
  },
);
