import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { withTimeout } from "../src/async-control.js";
import { sendSession } from "../src/session/execution/queue-owner-runtime.js";
import {
  closeSession,
  setSessionConfigOption,
  setSessionMode,
  setSessionModel,
} from "../src/session/execution/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { isProcessAlive } from "../src/session/queue/lease-store.js";
import type { AcpJsonRpcMessage, AcpMessageDirection, OutputFormatter } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const AGENT = `
import fs from 'node:fs';
import readline from 'node:readline';
const [logPath, releasePath] = process.argv.slice(2);
let mode = 'auto', model = 'default-model', effort = 'medium';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const options = () => [
  {id:'model', name:'Model', category:'model', type:'select', currentValue:model, options:['default-model','smart-model'].map(value=>({value,name:value}))},
  {id:'effort', name:'Effort', type:'select', currentValue:effort, options:['medium','high'].map(value=>({value,name:value}))},
];
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line), {id,method,params} = request;
  fs.appendFileSync(logPath,JSON.stringify({pid:process.pid,...request})+'\\n');
  const reply = result => send({id,result});
  if(method==='initialize') reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
  else if(method==='session/load') reply({configOptions:options(),modes:{currentModeId:mode,availableModes:[{id:'auto',name:'Auto'},{id:'plan',name:'Plan'}]}});
  else if(method==='session/new') send({id,error:{code:-32603,message:'Unexpected fresh session'}});
  else if(method==='session/set_mode'){mode=params.modeId;reply({});}
  else if(method==='session/set_config_option'){
    if(params.configId==='model')model=params.value;
    else if(params.configId==='effort')effort=params.value;
    reply({configOptions:options()});
  }else if(method==='session/prompt'){
    const finish=()=>{send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({pid:process.pid,mode,model,effort})}}}});reply({stopReason:'end_turn'});};
    if(params.prompt[0].text==='hold'){
      const tick=setInterval(()=>{if(fs.existsSync(releasePath)){clearInterval(tick);finish();}},10);
    }else finish();
  }else if(id!==undefined)reply({});
}).on('close',()=>process.exit(0));
`;

type BackendState = { pid: number; mode: string; model: string; effort: string };

type DirectionalDelivery = {
  message: AcpJsonRpcMessage;
  direction: AcpMessageDirection | undefined;
};

function capture(
  messages: AcpJsonRpcMessage[],
  deliveries?: DirectionalDelivery[],
): OutputFormatter {
  return {
    setContext() {},
    onAcpMessage(message, direction?: AcpMessageDirection) {
      messages.push(message);
      deliveries?.push({ message, direction });
    },
    onError() {},
    onPermissionEscalation() {},
    flush() {},
  };
}

function assertPromptDirections(deliveries: DirectionalDelivery[]): void {
  const request = deliveries.find(
    ({ message }) => "method" in message && message.method === "session/prompt" && "id" in message,
  );
  assert.ok(request);
  assert.ok("id" in request.message);
  assert.equal(request.direction, "outbound");
  const requestId = request.message.id;
  const update = deliveries.find(
    ({ message }) => "method" in message && message.method === "session/update",
  );
  assert.ok(update);
  assert.equal(update.direction, "inbound");
  const response = deliveries.find(
    ({ message }) =>
      "id" in message && message.id === requestId && !("method" in message) && "result" in message,
  );
  assert.ok(response);
  assert.equal(response.direction, "inbound");
}

function backendState(messages: AcpJsonRpcMessage[]): BackendState {
  const text = messages
    .filter((message) => "method" in message && message.method === "session/update")
    .map((message) => {
      const params =
        "params" in message
          ? (message.params as { update?: { content?: { text?: string } } })
          : undefined;
      return params?.update?.content?.text ?? "";
    })
    .join("");
  return JSON.parse(text) as BackendState;
}

for (const control of ["mode", "model", "effort"]) {
  test(`idle owner applies ${control} on its retained adapter`, { timeout: 20_000 }, async () => {
    await withTempHome("acpx-owner-controls-", async (home) => {
      const agent = path.join(home, "agent.mjs"),
        log = path.join(home, "wire.jsonl");
      await fs.writeFile(agent, AGENT);
      const record = makeSessionRecord({
        acpxRecordId: "control-record",
        acpSessionId: "saved-provider",
        cwd: home,
        ...normalizeAgentCommandInput([process.execPath, agent, log, path.join(home, "release")]),
      });
      await writeSessionRecordFile(home, record);
      const messages: AcpJsonRpcMessage[] = [];
      const deliveries: DirectionalDelivery[] = [];
      const prompt = () =>
        sendSession({
          sessionId: record.acpxRecordId,
          prompt: [{ type: "text", text: "state" }],
          permissionMode: "deny-all",
          ttlMs: 60_000,
          queueOwnerArgs: [
            fileURLToPath(new URL("../src/cli.js", import.meta.url)),
            "__queue-owner",
          ],
          timeoutMs: 5_000,
          outputFormatter: capture(messages, deliveries),
        });
      try {
        await prompt();
        assertPromptDirections(deliveries);
        const first = backendState(messages);
        messages.length = 0;
        deliveries.length = 0;
        if (control === "mode") {
          await setSessionMode({
            sessionId: record.acpxRecordId,
            modeId: "plan",
            timeoutMs: 5_000,
          });
        } else if (control === "model") {
          await setSessionModel({
            sessionId: record.acpxRecordId,
            modelId: "smart-model",
            timeoutMs: 5_000,
          });
        } else {
          await setSessionConfigOption({
            sessionId: record.acpxRecordId,
            configId: "effort",
            value: "high",
            timeoutMs: 5_000,
          });
        }
        await prompt();
        assertPromptDirections(deliveries);
        const after = backendState(messages);
        assert.equal(after.pid, first.pid, "controls must retain the warm adapter");
        assert.equal(
          after[control as "mode" | "model" | "effort"],
          control === "mode" ? "plan" : control === "model" ? "smart-model" : "high",
        );
      } finally {
        await closeSession(record.acpxRecordId);
      }
      const pids = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { pid: number }).pid);
      assert.equal(new Set(pids).size, 1, "idle control must not allocate a second adapter");
      for (const pid of new Set(pids)) {
        assert.equal(isProcessAlive(pid), false);
      }
    });
  });
}

test(
  "active mode acknowledgement survives final prompt checkpoint without a notification",
  { timeout: 20_000 },
  async () => {
    await withTempHome("acpx-active-control-", async (home) => {
      const agent = path.join(home, "agent.mjs"),
        log = path.join(home, "wire.jsonl"),
        release = path.join(home, "release");
      await fs.writeFile(agent, AGENT);
      const record = makeSessionRecord({
        acpxRecordId: "active-control",
        acpSessionId: "saved-provider",
        cwd: home,
        ...normalizeAgentCommandInput([process.execPath, agent, log, release]),
      });
      await writeSessionRecordFile(home, record);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const messages: AcpJsonRpcMessage[] = [];
      const prompt = sendSession({
        sessionId: record.acpxRecordId,
        prompt: [{ type: "text", text: "hold" }],
        permissionMode: "deny-all",
        ttlMs: 60_000,
        queueOwnerArgs: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "__queue-owner"],
        timeoutMs: 5_000,
        outputFormatter: capture(messages),
        onPromptStarted: started,
      });
      void prompt.catch(() => {});
      try {
        await withTimeout(Promise.race([ready, prompt]), 5_000);
        await setSessionMode({ sessionId: record.acpxRecordId, modeId: "plan", timeoutMs: 5_000 });
        assert.equal(
          (await resolveSessionRecord(record.acpxRecordId)).acpx?.desired_mode_id,
          "plan",
        );
        await fs.writeFile(release, "go");
        await prompt;
        assert.equal(backendState(messages).mode, "plan");
        assert.equal(
          (await resolveSessionRecord(record.acpxRecordId)).acpx?.desired_mode_id,
          "plan",
        );
      } finally {
        await fs.writeFile(release, "go");
        await prompt.catch(() => {});
        await closeSession(record.acpxRecordId);
      }
    });
  },
);
