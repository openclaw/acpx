import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { withTimeout } from "../src/async-control.js";
import { runSessionQueueOwner } from "../src/session/execution/queue-owner-runtime.js";
import { watchSession, type SessionWatchEvent } from "../src/session/journal.js";
import { SessionQueueOwner, trySubmitToRunningOwner } from "../src/session/queue/ipc.js";
import type { OutputFormatter } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// Hold the real ACP prompt after producing output so observer cleanup cannot
// be mistaken for prompt completion or cancellation.
const AGENT = `
import { appendFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
const [logPath, releasePath] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n');
const reply = (id, result) => send({id, result});
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const {id, method, params} = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify({method, text: params?.prompt?.[0]?.text}) + '\\n');
  if (method === 'initialize') reply(id, {protocolVersion: 1, agentCapabilities: {loadSession: true}});
  else if (method === 'session/load') reply(id, {});
  else if (method === 'session/prompt') {
    if (params.prompt[0].text !== 'held') { reply(id, {stopReason: 'end_turn'}); return; }
    for (let index = 0; index < 16; index++) send({method: 'session/update', params: {sessionId: params.sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'x'.repeat(128 * 1024)}}}});
    const waiting = setInterval(() => {
      if (existsSync(releasePath)) { clearInterval(waiting); reply(id, {stopReason: 'end_turn'}); }
    }, 10);
  }
}).on('close', () => process.exit(0));
`;

const DISCARD_OUTPUT: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
  flush() {},
};

function failSpoolWrites(t: TestContext) {
  const state = {
    writes: 0,
    descriptors: new Set<number>(),
    error: Object.assign(new Error("fixture output disk full"), { code: "ENOSPC" }),
  };
  const { openSync, closeSync, writeSync } = fsSync;
  t.mock.method(fsSync, "openSync", (...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    // Only the output ring opens a private read/write sync descriptor here.
    // Native lease guards also use writeSync and must retain their real writes.
    if (args[1] === "wx+" && args[2] === 0o600) {
      state.descriptors.add(fd);
    }
    return fd;
  });
  t.mock.method(fsSync, "closeSync", (fd: number) => {
    closeSync(fd);
    state.descriptors.delete(fd);
  });
  t.mock.method(fsSync, "writeSync", (...args: Parameters<typeof writeSync>) => {
    if (state.descriptors.has(args[0])) {
      state.writes += 1;
      throw state.error;
    }
    return writeSync(...args);
  });
  return state;
}

function observeSocketClose(socket: net.Socket) {
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  socket.on("error", onError);
  // events.once(close) rejects on the intentional spool error before close.
  // Observe both events from connection admission and assert the error below.
  let onClose!: () => void;
  const closed = withTimeout(
    new Promise<void>((resolve) => {
      onClose = resolve;
      socket.once("close", onClose);
    }),
    5000,
  ).finally(() => {
    socket.off("close", onClose);
    socket.off("error", onError);
  });
  void closed.catch(() => {});
  return { socket, errors, closed };
}

for (const detachment of ["stalled", "disconnected", "spool failure"] as const) {
  test(
    `${detachment} submitters detach while their prompt completes once and the successor runs`,
    {
      timeout: 20_000,
      skip:
        detachment === "stalled" &&
        process.platform === "win32" &&
        "Windows named pipes do not expose partial write progress",
    },
    async (t) => {
      const spoolFailure = detachment === "spool failure" ? failSpoolWrites(t) : undefined;
      await withTempHome("acpx-observer-detach-", async (home) => {
        const agentPath = path.join(home, "agent.mjs");
        const logPath = path.join(home, "agent.jsonl");
        const releasePath = path.join(home, "release");
        await fs.writeFile(agentPath, AGENT);
        const record = makeSessionRecord({
          acpxRecordId: "observer-record",
          acpSessionId: "saved-provider-session",
          ...normalizeAgentCommandInput([process.execPath, agentPath, logPath, releasePath]),
          cwd: home,
          eventLog: {
            active_path: "",
            segment_count: 1,
            max_segment_bytes: 8 * 1024 * 1024,
            max_segments: 2,
          },
        });
        await writeSessionRecordFile(home, record);

        let client: net.Socket | undefined;
        const createConnection = net.createConnection;
        t.mock.method(net, "createConnection", (...args: Parameters<typeof createConnection>) => {
          client = createConnection(...args);
          return client;
        });
        let observeConnection!: (socket: net.Socket) => void;
        const connected = new Promise<ReturnType<typeof observeSocketClose>>((resolve) => {
          observeConnection = (socket) => resolve(observeSocketClose(socket));
        });
        const start = SessionQueueOwner.start;
        t.mock.method(SessionQueueOwner, "start", async (...args: Parameters<typeof start>) => {
          const owner = await start(...args);
          const { server } = owner as unknown as { server: net.Server };
          server.once("connection", observeConnection);
          return owner;
        });

        const owner = runSessionQueueOwner({
          sessionId: record.acpxRecordId,
          permissionMode: "deny-all",
          ttlMs: 200,
        });
        void owner.catch(() => {});
        const submit = async (requestId: string, onQueueAccepted?: () => void) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const result = await trySubmitToRunningOwner({
              sessionId: record.acpxRecordId,
              requestId,
              message: requestId,
              permissionMode: "deny-all",
              resumePolicy: "same-session-only",
              outputFormatter: DISCARD_OUTPUT,
              waitForCompletion: true,
              onQueueAccepted,
            });
            if (result) {
              return result;
            }
            await delay(10);
          }
          throw new Error("The fixture owner never became ready");
        };
        try {
          let ready!: () => void;
          const accepted = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const first = submit("held", () => {
            assert.ok(client);
            client.pause();
            ready();
          });
          void first.catch(() => {});
          await withTimeout(Promise.race([accepted, first]), 5000);
          const { socket, errors, closed } = await connected;
          if (detachment === "disconnected") {
            assert.ok(client);
            client.destroy();
          }
          await closed;
          assert.equal(socket.writableLength, 0);
          assert.equal(errors.length, spoolFailure ? 1 : 0);
          if (spoolFailure) {
            assert.equal(errors[0], spoolFailure.error);
            assert.equal(spoolFailure.writes, 1, "the owned output spool must hit ENOSPC");
            assert.equal(spoolFailure.descriptors.size, 0, "the failed spool must close");
          }
          assert.ok(client);
          client.resume();
          await assert.rejects(first, {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
            retryable: false,
          });

          const successor = submit("successor");
          void successor.catch(() => {});
          await fs.writeFile(releasePath, "");
          const result = await successor;
          assert.ok(!("queued" in result));
          assert.equal(result.stopReason, "end_turn");

          const events: SessionWatchEvent[] = [];
          for await (const event of watchSession({ record, signal: AbortSignal.timeout(5000) })) {
            events.push(event);
            if (event.type === "turn_result" && event.requestId === "successor") {
              break;
            }
          }
          for (const requestId of ["held", "successor"]) {
            const turns = events.filter((event) => event.requestId === requestId);
            assert.equal(turns.filter((event) => event.type === "turn_started").length, 1);
            const result = turns.find((event) => event.type === "turn_result");
            assert.ok(result?.type === "turn_result");
            assert.equal(result.result.status, "completed");
          }
          const requests = (await fs.readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; text?: string });
          assert.deepEqual(
            requests
              .filter((request) => request.method === "session/prompt")
              .map(({ text }) => text),
            ["held", "successor"],
          );
          assert.equal(requests.filter((request) => request.method === "session/cancel").length, 0);
        } finally {
          client?.resume();
          await fs.writeFile(releasePath, "");
          await owner;
        }
      });
    },
  );
}
