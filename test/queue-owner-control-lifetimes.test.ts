import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { AcpClient } from "../src/acp/client.js";
import { sendSession } from "../src/session/execution/queue-owner-runtime.js";
import { closeSession, setSessionMode } from "../src/session/execution/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { isProcessAlive } from "../src/session/queue/lease-store.js";
import type { AcpJsonRpcMessage, OutputFormatter } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const AGENT = `
import fs from 'node:fs';import readline from 'node:readline';
const [logPath,controlRelease,promptRelease,loadRelease,scenario]=process.argv.slice(2);
let mode='auto',loaded=false,pendingPrompt;
const log=value=>fs.appendFileSync(logPath,JSON.stringify({pid:process.pid,...value})+'\\n');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const wait=(file,done)=>{const tick=setInterval(()=>{if(fs.existsSync(file)){clearInterval(tick);done();}},5);};
process.on('exit',()=>log({method:'exit'}));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line);log({method,sessionId:params?.sessionId,text:params?.prompt?.[0]?.text});
 const reply=result=>send({id,result});
 if(method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}}});
 else if(method==='session/load'){
   const finish=()=>{if(scenario==='starting-failure'){send({id,error:{code:-32002,message:'Saved session unavailable'}});return;}loaded=true;reply({modes:{currentModeId:mode,availableModes:[{id:'auto',name:'Auto'},{id:'plan',name:'Plan'}]}});};
   if(scenario.startsWith('starting'))wait(loadRelease,finish);else finish();
 }else if(method==='session/new')send({id,error:{code:-32603,message:'Unexpected new session'}});
 else if(method==='session/set_mode'){
   if(!loaded){send({id,error:{code:-32600,message:'Session not ready'}});return;}
   mode=params.modeId;
   const finish=()=>{log({method:'control-replied'});reply({});};
   if(scenario==='starting')finish();else wait(controlRelease,finish);
 }else if(method==='session/prompt'){
   const finish=(stopReason='end_turn')=>{send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({pid:process.pid,mode})}}}});log({method:'prompt-replied',text:params.prompt[0].text});reply({stopReason});pendingPrompt=undefined;};
   if(params.prompt[0].text==='hold'){pendingPrompt=finish;wait(promptRelease,()=>{if(pendingPrompt)finish();});}else finish();
 }else if(method==='session/cancel'&&pendingPrompt)pendingPrompt('cancelled');
 else if(id!==undefined)reply({});
}).on('close',()=>process.exit(0));
`;

type Wire = { pid: number; method: string; sessionId?: string; text?: string };

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "native milestone before deadline");
    await delay(10);
  }
}

function capture(messages: AcpJsonRpcMessage[]): OutputFormatter {
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

function state(messages: AcpJsonRpcMessage[]): { pid: number; mode: string } {
  const text = messages
    .map((message) => {
      if (!("method" in message) || message.method !== "session/update" || !("params" in message)) {
        return "";
      }
      const params = message.params as { update?: { content?: { text?: string } } };
      return params.update?.content?.text ?? "";
    })
    .join("");
  return JSON.parse(text) as { pid: number; mode: string };
}

async function fixture(
  scenario: string,
  run: (value: {
    recordId: string;
    rows: () => Promise<Wire[]>;
    send: (text: string) => {
      result: ReturnType<typeof sendSession>;
      messages: AcpJsonRpcMessage[];
    };
    setMode: (timeoutMs?: number) => ReturnType<typeof setSessionMode>;
    releaseControl: () => Promise<void>;
    releasePrompt: () => Promise<void>;
    releaseLoad: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-control-lifetime-", async (home) => {
    const agent = path.join(home, "agent.mjs"),
      log = path.join(home, "wire.jsonl");
    const controlRelease = path.join(home, "control"),
      promptRelease = path.join(home, "prompt"),
      loadRelease = path.join(home, "load");
    await fs.writeFile(agent, AGENT);
    const record = makeSessionRecord({
      acpxRecordId: "control-lifetime",
      acpSessionId: "saved-provider",
      cwd: home,
      ...normalizeAgentCommandInput([
        process.execPath,
        agent,
        log,
        controlRelease,
        promptRelease,
        loadRelease,
        scenario,
      ]),
    });
    await writeSessionRecordFile(home, record);
    const pending: Promise<unknown>[] = [];
    const track = <T>(operation: Promise<T>): Promise<T> => {
      pending.push(operation);
      void operation.catch(() => {});
      return operation;
    };
    const rows = async () => {
      try {
        return (await fs.readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Wire);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    };
    try {
      await run({
        recordId: record.acpxRecordId,
        rows,
        send: (text) => {
          const messages: AcpJsonRpcMessage[] = [];
          return {
            messages,
            result: track(
              sendSession({
                sessionId: record.acpxRecordId,
                prompt: [{ type: "text", text }],
                permissionMode: "deny-all",
                resumePolicy: "same-session-only",
                ttlMs: scenario === "ttl" ? 150 : 60_000,
                timeoutMs: 6000,
                outputFormatter: capture(messages),
                queueOwnerArgs: [
                  fileURLToPath(new URL("../src/cli.js", import.meta.url)),
                  "__queue-owner",
                ],
              }),
            ),
          };
        },
        setMode: (timeoutMs = 5000) =>
          track(setSessionMode({ sessionId: record.acpxRecordId, modeId: "plan", timeoutMs })),
        releaseControl: () => fs.writeFile(controlRelease, "go"),
        releasePrompt: () => fs.writeFile(promptRelease, "go"),
        releaseLoad: () => fs.writeFile(loadRelease, "go"),
      });
    } finally {
      await Promise.all([
        fs.writeFile(controlRelease, "go"),
        fs.writeFile(promptRelease, "go"),
        fs.writeFile(loadRelease, "go"),
      ]);
      await Promise.allSettled(pending);
      await closeSession(record.acpxRecordId);
      for (const pid of new Set((await rows()).map((row) => row.pid))) {
        assert.equal(isProcessAlive(pid), false, "native peer must exit during cleanup");
      }
    }
  });
}

test(
  "active control acknowledgement crosses prompt completion before successor admission",
  { timeout: 20000 },
  async () => {
    await fixture("active", async (f) => {
      const first = f.send("hold");
      await until(async () => (await f.rows()).some((row) => row.method === "session/prompt"));
      const control = f.setMode();
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      await f.releasePrompt();
      await until(async () => (await f.rows()).some((row) => row.method === "prompt-replied"));
      let finished = false;
      void first.result.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      const next = f.send("next");
      await delay(100);
      assert.equal(finished, false, "finalization must retain the admitted control context");
      assert.equal((await f.rows()).filter((row) => row.method === "session/prompt").length, 1);
      await f.releaseControl();
      await Promise.all([control, first.result, next.result]);
      assert.equal(state(next.messages).mode, "plan");
      assert.equal(state(first.messages).pid, state(next.messages).pid);
      assert.equal((await resolveSessionRecord(f.recordId)).acpx?.desired_mode_id, "plan");
    });
  },
);

test(
  "a prompt selected during an idle control waits for its accepted state",
  { timeout: 20000 },
  async () => {
    await fixture("idle", async (f) => {
      const warm = f.send("warm");
      await warm.result;
      const control = f.setMode();
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      const next = f.send("next");
      await delay(100);
      assert.equal((await f.rows()).filter((row) => row.method === "session/prompt").length, 1);
      await f.releaseControl();
      await Promise.all([control, next.result]);
      assert.equal(state(next.messages).mode, "plan");
      assert.equal(state(next.messages).pid, state(warm.messages).pid);
    });
  },
);

test(
  "starting controls wait for load and remain usable after prompt completion",
  { timeout: 20000 },
  async () => {
    await fixture("starting", async (f) => {
      const first = f.send("first");
      await until(async () => (await f.rows()).some((row) => row.method === "session/load"));
      const control = f.setMode();
      await delay(100);
      assert.equal(
        (await f.rows()).some((row) => row.method === "session/set_mode"),
        false,
      );
      await f.releaseLoad();
      await Promise.all([control, first.result]);
      const next = f.send("next");
      await next.result;
      assert.equal(state(next.messages).mode, "plan");
      assert.equal((await resolveSessionRecord(f.recordId)).acpx?.desired_mode_id, "plan");
    });
  },
);

test(
  "timed-out idle control retires its connection before the next prompt",
  { timeout: 20000 },
  async () => {
    await fixture("timeout", async (f) => {
      const warm = f.send("warm");
      await warm.result;
      const control = f.setMode(300);
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      await assert.rejects(control, /timed out/i);
      const next = f.send("next");
      await next.result;
      assert.notEqual(state(next.messages).pid, state(warm.messages).pid);
      const rows = await f.rows();
      assert.equal(rows.filter((row) => row.method === "session/set_mode").length, 1);
      assert.ok(
        rows
          .filter((row) => row.method === "session/load")
          .every((row) => row.sessionId === "saved-provider"),
      );
      const oldExit = rows.findIndex(
        (row) => row.method === "exit" && row.pid === state(warm.messages).pid,
      );
      const nextPrompt = rows.findIndex(
        (row) => row.method === "session/prompt" && row.text === "next",
      );
      assert.ok(oldExit >= 0 && oldExit < nextPrompt);
    });
  },
);

test(
  "close drains an admitted idle control and preserves its acknowledgement socket",
  { timeout: 20000 },
  async () => {
    await fixture("closing", async (f) => {
      await f.send("warm").result;
      const control = f.setMode();
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      const closing = closeSession(f.recordId);
      void closing.catch(() => {});
      await delay(100);
      await f.releaseControl();
      await Promise.all([control, closing]);
      const saved = await resolveSessionRecord(f.recordId);
      assert.equal(saved.closed, true);
      assert.equal(saved.acpx?.desired_mode_id, "plan");
    });
  },
);

test(
  "idle TTL does not expire while an admitted control is awaiting its reply",
  { timeout: 20000 },
  async () => {
    await fixture("ttl", async (f) => {
      const warm = f.send("warm");
      await warm.result;
      const control = f.setMode();
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      await delay(350);
      assert.equal(
        (await f.rows()).some((row) => row.method === "exit"),
        false,
      );
      await f.releaseControl();
      await control;
      const next = f.send("next");
      await next.result;
      assert.equal(state(next.messages).pid, state(warm.messages).pid);
      assert.equal(state(next.messages).mode, "plan");
    });
  },
);

test(
  "timed-out active control retires its prompt context before the successor",
  { timeout: 20000 },
  async () => {
    await fixture("active-timeout", async (f) => {
      const first = f.send("hold");
      await until(async () => (await f.rows()).some((row) => row.method === "session/prompt"));
      const control = f.setMode(300);
      await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
      const firstPid = (await f.rows()).find((row) => row.method === "session/prompt")!.pid;
      await assert.rejects(control, /timed out/i);
      await assert.rejects(first.result);
      const next = f.send("next");
      await next.result;
      const rows = await f.rows();
      const exited = rows.findIndex((row) => row.method === "exit" && row.pid === firstPid);
      const successor = rows.findIndex(
        (row) => row.method === "session/prompt" && row.text === "next",
      );
      assert.ok(exited >= 0 && exited < successor);
      assert.notEqual(state(next.messages).pid, firstPid);
      assert.equal(rows.filter((row) => row.method === "session/set_mode").length, 1);
      assert.equal((await resolveSessionRecord(f.recordId)).acpx?.desired_mode_id, undefined);
    });
  },
);

test(
  "failed prompt preparation rejects starting controls without dispatching them",
  { timeout: 20000 },
  async () => {
    await fixture("starting-failure", async (f) => {
      const first = f.send("first");
      await until(async () => (await f.rows()).some((row) => row.method === "session/load"));
      const control = f.setMode();
      await delay(50);
      await f.releaseLoad();
      await assert.rejects(first.result, /Saved session unavailable|resume/i);
      await assert.rejects(control, /ended before controls became ready/);
      assert.equal(
        (await f.rows()).some((row) => row.method === "session/set_mode"),
        false,
      );
    });
  },
);

test(
  "direct controls retain ownership through client cleanup before concurrent close",
  { timeout: 20000 },
  async (t) => {
    await fixture("direct", async (f) => {
      let entered!: () => void, release!: () => void;
      const atClose = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const allowed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = AcpClient.prototype.close;
      t.mock.method(AcpClient.prototype, "close", async function (this: AcpClient) {
        entered();
        await allowed;
        await close.call(this);
      });
      const control = f.setMode();
      let closing: ReturnType<typeof closeSession> | undefined;
      try {
        await until(async () => (await f.rows()).some((row) => row.method === "session/set_mode"));
        await f.releaseControl();
        await atClose;
        closing = closeSession(f.recordId);
        void closing.catch(() => {});
        await delay(250);
        release();
        await Promise.all([control, closing]);
        const record = await resolveSessionRecord(f.recordId);
        assert.equal(record.closed, true);
        assert.equal(record.acpx?.desired_mode_id, "plan");
      } finally {
        release();
        await control.catch(() => {});
        await closing?.catch(() => {});
        t.mock.restoreAll();
      }
    });
  },
);
