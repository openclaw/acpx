import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { withTimeout } from "../src/async-control.js";
import { sessionEventLockPath } from "../src/session/event-log.js";
import { listSessionEvents } from "../src/session/events.js";
import { sendSession } from "../src/session/execution/queue-owner-runtime.js";
import { closeSession } from "../src/session/execution/session-control.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import { isProcessAlive, readQueueOwnerRecord } from "../src/session/queue/lease-store.js";
import { acquireSessionTurn } from "../src/session/turn-ownership.js";
import type { AcpJsonRpcMessage, OutputFormatter } from "../src/types.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

for (const disposition of ["updated", "removed"]) {
  test(`closeSession rereads the ${disposition} record after acquiring writer ownership`, async (t) => {
    await withTempHome("acpx-close-writer-", async (home) => {
      const record = makeSessionRecord({
        acpxRecordId: "close-record",
        acpSessionId: "close-backend",
        agentCommand: "unused",
        cwd: home,
      });
      await writeSessionRecordFile(home, record);
      const ownership = await acquireSessionTurn(record.acpxRecordId);
      let attempted!: () => void;
      const admission = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      const link = fs.link.bind(fs);
      t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
        if (args[1] === sessionEventLockPath(record.acpxRecordId)) {
          attempted();
        }
        return await link(...args);
      });
      const closing = closeSession(record.acpSessionId);
      void closing.catch(() => {});
      try {
        await withTimeout(
          Promise.race([
            admission,
            closing.then(() => {
              throw new Error("Close bypassed the active writer");
            }),
          ]),
          5_000,
        );
        assert.equal((await resolveSessionRecord(record.acpxRecordId)).closed, false);
        if (disposition === "removed") {
          await fs.unlink(sessionFilePath(home, record.acpxRecordId));
        } else {
          record.title = "latest writer title";
          record.lastRequestId = "latest-writer-request";
          record.cumulative_token_usage = { input_tokens: 9, output_tokens: 4 };
          record.acpx = { desired_config_options: { effort: "high" } };
          await writeSessionRecord(record);
        }
      } finally {
        await ownership[Symbol.asyncDispose]();
        await closing.catch(() => {});
      }
      if (disposition === "removed") {
        await assert.rejects(closing);
        await assert.rejects(fs.access(sessionFilePath(home, record.acpxRecordId)), {
          code: "ENOENT",
        });
      } else {
        const closed = await closing;
        for (const saved of [closed, await resolveSessionRecord(record.acpxRecordId)]) {
          assert.equal(saved.closed, true);
          assert.equal(saved.acpxRecordId, record.acpxRecordId);
          assert.equal(saved.acpSessionId, record.acpSessionId);
          assert.equal(saved.title, record.title);
          assert.equal(saved.lastRequestId, record.lastRequestId);
          assert.deepEqual(saved.cumulative_token_usage, record.cumulative_token_usage);
          assert.deepEqual(saved.acpx?.desired_config_options, { effort: "high" });
        }
      }
    });
  });
}

const FINAL_NOTE_AGENT = `
import fs from 'node:fs';
import readline from 'node:readline';
const [pidPath, logPath] = process.argv.slice(2);
fs.writeFileSync(pidPath, String(process.pid));
let pending;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
const update = value => send({method:'session/update',params:{sessionId:pending.params.sessionId,update:value}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(request)+'\\n');
  if(request.method==='initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  else if(request.method==='session/load') send({id:request.id,result:{}});
  else if(request.method==='session/prompt') pending=request;
  else if(request.method==='session/cancel' && pending) {
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'final cancellation checkpoint'}});
    update({sessionUpdate:'usage_update',size:13,used:13,_meta:{usage:{inputTokens:9,outputTokens:4,totalTokens:13}}});
    update({sessionUpdate:'config_option_update',configOptions:[{id:'effort',name:'Effort',type:'select',currentValue:'high',options:[{value:'high',name:'High'}]}]});
    send({id:pending.id,result:{stopReason:'cancelled'}});
    pending=undefined;
  }
}).on('close',()=>process.exit(0));
`;

test(
  "closeSession preserves the final checkpoint from a draining queue owner",
  { skip: process.platform === "win32", timeout: 20_000 },
  async () => {
    await withTempHome("acpx-close-checkpoint-", async (home) => {
      const agentPath = path.join(home, "agent.mjs");
      const pidPath = path.join(home, "agent.pid");
      const logPath = path.join(home, "agent.jsonl");
      await fs.writeFile(agentPath, FINAL_NOTE_AGENT);
      const record = makeSessionRecord({
        acpxRecordId: "close-live-record",
        acpSessionId: "saved-provider-session",
        cwd: home,
        ...normalizeAgentCommandInput([process.execPath, agentPath, pidPath, logPath]),
        eventLog: {
          active_path: "",
          segment_count: 1,
          max_segment_bytes: 1024 * 1024,
          max_segments: 5,
        },
      });
      await writeSessionRecordFile(home, record);
      const output: AcpJsonRpcMessage[] = [];
      const formatter: OutputFormatter = {
        setContext() {},
        onAcpMessage(message) {
          output.push(message);
        },
        onError() {},
        onPermissionEscalation() {},
        flush() {},
      };
      let promptStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve;
      });
      const turn = sendSession({
        sessionId: record.acpxRecordId,
        requestId: "closing-turn",
        prompt: [{ type: "text", text: "hold" }],
        permissionMode: "deny-all",
        outputFormatter: formatter,
        resumePolicy: "same-session-only",
        onPromptStarted: promptStarted,
        timeoutMs: 10_000,
        ttlMs: 60_000,
        queueOwnerArgs: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "__queue-owner"],
      });
      void turn.catch(() => {});
      try {
        await withTimeout(
          Promise.race([
            started,
            turn.then(() => {
              throw new Error("Turn never reached the agent");
            }),
          ]),
          5_000,
        );
        const owner = await readQueueOwnerRecord(record.acpxRecordId);
        assert.ok(owner);
        assert.notEqual(owner.pid, process.pid, "closing must only signal the child owner");
        const closed = await closeSession(record.acpxRecordId);
        const result = await turn;
        assert.ok("stopReason" in result);
        assert.equal(result.stopReason, "cancelled");
        assert.match(JSON.stringify(output), /final cancellation checkpoint/);
        const events = await listSessionEvents(record.acpxRecordId);
        assert.match(JSON.stringify(events), /final cancellation checkpoint/);
        for (const saved of [closed, await resolveSessionRecord(record.acpxRecordId)]) {
          assert.equal(saved.closed, true);
          assert.equal(typeof saved.closedAt, "string");
          assert.equal(saved.pid, undefined);
          assert.equal(saved.acpxRecordId, record.acpxRecordId);
          assert.equal(saved.acpSessionId, record.acpSessionId);
          assert.equal(saved.lastRequestId, "closing-turn");
          assert.equal(saved.lastSeq, events.length);
          assert.match(JSON.stringify(saved.messages), /final cancellation checkpoint/);
          assert.equal(saved.cumulative_token_usage.input_tokens, 9);
          assert.equal(saved.cumulative_token_usage.output_tokens, 4);
          assert.equal(saved.acpx?.config_options?.[0]?.currentValue, "high");
        }
        assert.equal(isProcessAlive(owner.pid), false);
        assert.equal(isProcessAlive(Number(await fs.readFile(pidPath, "utf8"))), false);
        assert.doesNotMatch(await fs.readFile(logPath, "utf8"), /session\/new/);
      } finally {
        await closeSession(record.acpxRecordId);
        await turn.catch(() => {});
      }
    });
  },
);
