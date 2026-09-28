import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { normalizeAgentCommandInput } from "../../src/acp/client-process.js";
import { AcpClient } from "../../src/acp/client.js";
import { withTimeout } from "../../src/async-control.js";
import { runSessionQueueOwner } from "../../src/session/execution/queue-owner-runtime.js";
import { watchSession, type SessionWatchEvent } from "../../src/session/journal.js";
import { resolveSessionRecord } from "../../src/session/persistence.js";
import { trySubmitToRunningOwner } from "../../src/session/queue/ipc.js";
import { isProcessAlive } from "../../src/session/queue/lease-store.js";
import type { AcpJsonRpcMessage, OutputFormatter } from "../../src/types.js";
import { makeSessionRecord, writeSessionRecordFile } from "../runtime-test-helpers.js";

// A real transport peer that deliberately keeps the first prompt unresolved.
const AGENT = `
import { appendFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline';
const [logPath, mode] = process.argv.slice(2);
let active = 0, held;
const log = (entry) => appendFileSync(logPath, JSON.stringify({pid: process.pid, ...entry}) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n');
const reply = (id, result) => send({id, result});
const text = (sessionId, text) => send({method: 'session/update', params: {sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}}}});
process.on('exit', () => log({method: 'exit'}));
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const {id, method, params} = JSON.parse(line);
  log({method, sessionId: params?.sessionId, text: params?.prompt?.[0]?.text});
  if (method === 'initialize') reply(id, {protocolVersion: 1, agentCapabilities: {loadSession: true}});
  else if (method === 'session/load') {
    if (mode === 'load-failure' && readFileSync(logPath, 'utf8').includes('session/cancel'))
      send({id, error: {code: -32002, message: 'Saved session unavailable'}});
    else reply(id, {});
  } else if (method === 'session/new') send({id, error: {code: -32603, message: 'Unexpected new session'}});
  else if (method === 'session/prompt') {
    active++;
    log({method: 'active', active});
    if (params.prompt[0].text === 'hold') {
      held = {id, sessionId: params.sessionId};
      if (mode === 'partial') text(params.sessionId, 'partial-first');
    } else {
      text(params.sessionId, 'successor');
      active--;
      reply(id, {stopReason: 'end_turn'});
    }
  } else if (method === 'session/cancel' && mode === 'cooperative' && held) {
    text(held.sessionId, 'final-cancel-note');
    active--;
    reply(held.id, {stopReason: 'cancelled', usage: {inputTokens: 9}});
    held = undefined;
  }
}).on('close', () => process.exit(0));
`;

type AgentLog = { pid: number; method: string; sessionId?: string; text?: string; active?: number };

function captureOutput(messages: AcpJsonRpcMessage[]): OutputFormatter {
  return {
    setContext() {},
    onAcpMessage(message) {
      messages.push(message);
    },
    onError() {},
    onPermissionEscalation() {},
    flush() {},
  };
}

// A timed wait does not cancel its input: keep every promise owned by this host.
export async function settleQueueCase(
  body: () => Promise<void>,
  owner: Promise<void>,
  submissions: Promise<unknown>[],
  cleanupMs = 15_000,
): Promise<void> {
  const errors: unknown[] = [];
  let ownerFailure: { error: unknown } | undefined;
  const joinedOwner = owner.catch((error: unknown) => {
    ownerFailure = { error };
  });
  try {
    await body();
  } catch (error) {
    errors.push(error);
  }
  try {
    await withTimeout(Promise.all([joinedOwner, Promise.allSettled(submissions)]), cleanupMs);
  } catch (error) {
    errors.push(error);
  }
  if (ownerFailure) {
    errors.push(ownerFailure.error);
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Queue timeout body and cleanup failed", { cause: errors[0] });
  }
  if (errors.length === 1) {
    throw errors[0];
  }
}

export function guardQueueControllerLoss(
  requestStop: () => void,
  exitAfterMs = 5_000,
): (success: boolean) => void {
  let stopping = false;
  const disconnected = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.exitCode = 1;
    // A dead controller cannot enforce its deadlines. Closing this host also closes peer stdin.
    setTimeout(() => {
      try {
        writeSync(2, "Queue fixture cleanup did not settle; forcing failed exit\n");
      } finally {
        process.exit(1);
      }
    }, exitAfterMs).unref();
    requestStop();
  };
  process.once("disconnect", disconnected);
  return (success) => {
    process.off("disconnect", disconnected);
    if (!success) {
      disconnected();
    }
  };
}

async function runQueueCase(home: string, mode: string): Promise<void> {
  const agentPath = path.join(home, "agent.mjs");
  const logPath = path.join(home, "agent.jsonl");
  await fs.writeFile(agentPath, AGENT);
  const record = makeSessionRecord({
    acpxRecordId: "timeout-record",
    acpSessionId: "saved-provider-session",
    ...normalizeAgentCommandInput([
      process.execPath,
      agentPath,
      logPath,
      mode === "settled-close-failure" ? "cooperative" : mode,
    ]),
    cwd: home,
    eventLog: {
      active_path: "",
      segment_count: 1,
      max_segment_bytes: 1024 * 1024,
      max_segments: 5,
    },
  });
  await writeSessionRecordFile(home, record);
  let failedClose = false;
  const closeFails = mode === "close-failure" || mode === "settled-close-failure";
  if (closeFails) {
    // Preserve the original method; the wrapper supplies its current client receiver below.
    // oxlint-disable-next-line typescript/unbound-method
    const original = AcpClient.prototype.close;
    mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
      if (!failedClose) {
        assert.equal(this.hasUnresolvedPrompt(), mode === "close-failure");
        failedClose = true;
        throw new Error("Synthetic retirement failure");
      }
      await original.call(this);
    });
  }
  if (mode === "stalled-cancel") {
    mock.method(AcpClient.prototype, "cancelActivePrompt", () => new Promise(() => {}));
  }

  const owner = runSessionQueueOwner({
    sessionId: record.acpxRecordId,
    permissionMode: "deny-all",
    ttlMs: 200,
  });
  void owner.catch(() => {});
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let queueAccepted!: () => void;
  const queued = new Promise<void>((resolve) => {
    queueAccepted = resolve;
  });
  const outputs: AcpJsonRpcMessage[][] = [[], []];
  const submit = async (index: number) => {
    for (let retry = 0; retry < 100; retry++) {
      const result = await trySubmitToRunningOwner({
        sessionId: record.acpxRecordId,
        requestId: index === 0 ? "first" : "second",
        message: index === 0 ? "hold" : "next",
        requireSharedRuntime: true,
        resumePolicy: "same-session-only",
        permissionMode: "deny-all",
        outputFormatter: captureOutput(outputs[index]),
        waitForCompletion: true,
        timeoutMs: index === 0 ? 1_500 : 5_000,
        onPromptStarted: index === 0 ? promptStarted : undefined,
        onQueueAccepted: index === 1 ? queueAccepted : undefined,
      });
      if (result) {
        return result;
      }
      await delay(10);
    }
    throw new Error("Owner never became ready");
  };
  const submissions: Promise<unknown>[] = [];
  const first = submit(0);
  submissions.push(first);
  void first.catch(() => {});
  await settleQueueCase(
    async () => {
      await withTimeout(Promise.race([started, first]), 5_000);
      const second = submit(1);
      submissions.push(second);
      void second.catch(() => {});
      await withTimeout(Promise.race([queued, second]), 5_000);
      await assert.rejects(first, closeFails ? /Synthetic retirement failure/ : /Timed out/);
      if (closeFails) {
        assert.equal(failedClose, true);
        await assert.rejects(second, { detailCode: "QUEUE_OWNER_SHUTTING_DOWN" });
      } else if (mode === "load-failure") {
        await assert.rejects(second, /Saved session unavailable|resume/i);
      } else {
        const result = await second;
        assert.ok("stopReason" in result);
        assert.equal(result.stopReason, "end_turn");
      }
    },
    owner,
    submissions,
  );

  const logs = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AgentLog);
  assert.equal(
    logs.some((entry) => entry.method === "session/new"),
    false,
  );
  assert.ok(
    logs
      .filter((entry) => entry.method === "session/load")
      .every((entry) => entry.sessionId === record.acpSessionId),
  );
  assert.ok(
    logs.filter((entry) => entry.method === "active").every((entry) => entry.active === 1),
    "native prompts must never overlap",
  );
  const firstPrompt = logs.find((entry) => entry.method === "session/prompt");
  assert.ok(firstPrompt);
  const successor = logs.find(
    (entry) => entry.method === "session/prompt" && entry.text === "next",
  );
  if (closeFails || mode === "load-failure") {
    assert.equal(successor, undefined);
  } else {
    assert.ok(successor);
    assert.notEqual(successor.pid, firstPrompt.pid);
    const oldExit = logs.findIndex(
      (entry) => entry.pid === firstPrompt.pid && entry.method === "exit",
    );
    assert.ok(
      oldExit >= 0 && oldExit < logs.indexOf(successor),
      "old process exits before successor dispatch",
    );
  }
  for (const pid of new Set(logs.map((entry) => entry.pid))) {
    assert.equal(isProcessAlive(pid), false);
  }
  const saved = await resolveSessionRecord(record.acpxRecordId);
  assert.equal(saved.acpSessionId, record.acpSessionId);
  assert.equal(saved.closed, false);
  const journal: SessionWatchEvent[] = [];
  for await (const event of watchSession({
    record: saved,
    signal: AbortSignal.timeout(5_000),
  })) {
    journal.push(event);
    if (event.type === "turn_result" && event.requestId === "first") {
      break;
    }
  }
  const result = journal.at(-1);
  assert.equal(result?.type, "turn_result");
  if (result?.type === "turn_result") {
    assert.equal(result.result.status, "failed");
  }
  if (mode === "cooperative") {
    assert.match(JSON.stringify(outputs[0]), /final-cancel-note/);
    assert.doesNotMatch(JSON.stringify(outputs[1]), /final-cancel-note/);
    const note = journal.findIndex(
      (entry) =>
        entry.type === "message" && JSON.stringify(entry.message).includes("final-cancel-note"),
    );
    assert.ok(note >= 0 && note < journal.length - 1);
    assert.equal(journal[note].requestId, "first");
    assert.match(JSON.stringify(saved.messages), /final-cancel-note/);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [home, mode] = process.argv.slice(2);
  const cleanupFailureControl = mode === "fixture-cleanup-timeout";
  let success = false;
  let stopped = false;
  const requestStop = (): void => {
    stopped = true;
    process.emit("SIGTERM");
  };
  const stop = (message: unknown): void => {
    if (message === "stop") {
      requestStop();
    }
  };
  process.on("message", stop);
  const finishControllerGuard = guardQueueControllerLoss(
    requestStop,
    cleanupFailureControl ? 50 : undefined,
  );
  try {
    assert.ok(home && mode);
    assert.equal(process.env.HOME, home);
    if (process.platform === "win32") {
      assert.equal(process.env.USERPROFILE, home);
    }
    if (cleanupFailureControl) {
      // Exercise this host's failed finally with an inert owner that ignores graceful stop.
      process.on("SIGTERM", () => process.stderr.write("Fixture failure control received stop\n"));
      setInterval(() => {}, 1_000);
      await settleQueueCase(
        async () => {
          throw new Error("Synthetic fixture body failure");
        },
        new Promise<void>(() => {}),
        [],
        1,
      );
    } else {
      await runQueueCase(home, mode);
    }
    assert.equal(stopped, false, "A rescued queue fixture cannot pass");
    await fs.writeFile(path.join(home, "result.json"), JSON.stringify({ outcome: "passed" }));
    assert.equal(stopped, false, "A rescued queue fixture cannot pass");
    success = true;
  } catch (error) {
    const detail = inspect(error, { depth: 10 });
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
    if (home) {
      await fs.writeFile(
        path.join(home, "result.json"),
        JSON.stringify({ outcome: "failed", detail }),
      );
    }
  } finally {
    mock.restoreAll();
    process.off("message", stop);
    finishControllerGuard(success);
    if (process.connected) {
      process.disconnect?.();
    }
  }
}
