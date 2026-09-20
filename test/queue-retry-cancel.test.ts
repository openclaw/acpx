import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { AcpClient } from "../src/acp/client.js";
import { withTimeout } from "../src/async-control.js";
import { runSessionQueueOwner } from "../src/session/execution/queue-owner-runtime.js";
import { watchSession } from "../src/session/journal.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { tryCancelOnRunningOwner, trySubmitToRunningOwner } from "../src/session/queue/ipc.js";
import { isProcessAlive } from "../src/session/queue/lease-store.js";
import type { OutputFormatter } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RETRY_AGENT = `
import fs from 'node:fs';import readline from 'node:readline';
const logPath=process.argv[2];let pending;const attempts=new Map();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);fs.appendFileSync(logPath,JSON.stringify({pid:process.pid,...request})+'\\n');
 if(request.method==='initialize')send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 else if(request.method==='session/load')send({id:request.id,result:{}});
 else if(request.method==='session/prompt'){
  const mode=request.params.prompt[0].text;const attempt=(attempts.get(mode)||0)+1;attempts.set(mode,attempt);
  if(mode==='backoff'&&attempt===1)send({id:request.id,error:{code:-32603,message:'synthetic retry failure'}});
  else if(['active-error','cooperative','fatal'].includes(mode)&&attempt===1)pending=request;
  else if(mode==='settled'){
   send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'usage_update',size:9,used:9,_meta:{usage:{inputTokens:9}}}}});
   send({id:request.id,result:{stopReason:'max_tokens',_meta:{proof:'settled-response'}}});
  }else send({id:request.id,result:{stopReason:'end_turn'}});
 }else if(request.method==='session/cancel'&&pending){
  const mode=pending.params.prompt[0].text;
  if(mode==='cooperative')send({id:pending.id,result:{stopReason:'cancelled',_meta:{proof:'cooperative-response'}}});
  else send({id:pending.id,error:{code:mode==='fatal'?-32602:-32603,message:mode==='fatal'?'synthetic fatal failure':'synthetic retry failure'}});
  pending=undefined;
 }
}).on('close',()=>process.exit(0));
`;

type PeerRequest = {
  pid: number;
  method?: string;
  params?: { sessionId: string; prompt?: Array<{ text: string }> };
};

for (const mode of ["backoff", "active-error", "cooperative", "gap", "settled", "fatal"]) {
  test(
    `queue cancellation owns retries without replacing native outcomes: ${mode}`,
    { timeout: 25_000 },
    async (t) => {
      await withTempHome("acpx-retry-cancel-", async (home) => {
        const peerPath = path.join(home, "peer.mjs");
        const logPath = path.join(home, "peer.jsonl");
        await fs.writeFile(peerPath, RETRY_AGENT);
        const record = makeSessionRecord({
          acpxRecordId: "retry-record",
          acpSessionId: "saved-retry-session",
          cwd: home,
          ...normalizeAgentCommandInput([process.execPath, peerPath, logPath]),
          eventLog: {
            active_path: "",
            segment_count: 1,
            max_segment_bytes: 1024 * 1024,
            max_segments: 5,
          },
        });
        await writeSessionRecordFile(home, record);
        const accepted = deferred<void>();
        const successorAccepted = deferred<void>();
        const nativeStarted = deferred<void>();
        const retryError = deferred<void>();
        const drainEntered = deferred<void>();
        const releaseDrain = deferred<void>();
        let promptWrites = 0;
        let gapCancelled = false;
        let nativeFulfilled = false;
        let drainPaused = false;
        if (mode === "gap" || mode === "settled") {
          const prompt = AcpClient.prototype.prompt;
          t.mock.method(
            AcpClient.prototype,
            "prompt",
            async function (this: AcpClient, ...args: Parameters<AcpClient["prompt"]>) {
              if (mode === "gap" && !gapCancelled) {
                await successorAccepted.promise;
                gapCancelled =
                  (await tryCancelOnRunningOwner({
                    sessionId: record.acpxRecordId,
                    targetRequestId: "cancel-target",
                  })) === true;
                assert.equal(gapCancelled, true);
              }
              const response = await prompt.apply(this, args);
              nativeFulfilled = true;
              return response;
            },
          );
        }
        if (mode === "settled") {
          const drain = AcpClient.prototype.waitForSessionUpdatesIdle;
          t.mock.method(
            AcpClient.prototype,
            "waitForSessionUpdatesIdle",
            async function (
              this: AcpClient,
              ...args: Parameters<AcpClient["waitForSessionUpdatesIdle"]>
            ) {
              if (nativeFulfilled && !drainPaused) {
                drainPaused = true;
                drainEntered.resolve();
                await releaseDrain.promise;
              }
              await drain.apply(this, args);
            },
          );
        }
        const formatter: OutputFormatter = {
          setContext() {},
          onError() {},
          onPermissionEscalation() {},
          flush() {},
          onAcpMessage(message) {
            if (JSON.stringify(message).includes("synthetic retry failure")) {
              retryError.resolve();
            }
          },
        };
        const owner = runSessionQueueOwner({
          sessionId: record.acpxRecordId,
          permissionMode: "deny-all",
          ttlMs: 200,
          suppressSdkConsoleErrors: true,
        });
        void owner.catch(() => {});
        const submit = async (successor: boolean) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const result = await trySubmitToRunningOwner({
              sessionId: record.acpxRecordId,
              requestId: successor ? "successor" : "cancel-target",
              message: successor ? "successor" : mode,
              requireSharedRuntime: true,
              resumePolicy: "same-session-only",
              permissionMode: "deny-all",
              outputFormatter: formatter,
              waitForCompletion: true,
              timeoutMs: 5000,
              promptRetries: 1,
              suppressSdkConsoleErrors: true,
              onQueueAccepted: successor ? successorAccepted.resolve : accepted.resolve,
              onPromptStarted: successor
                ? undefined
                : () => {
                    promptWrites += 1;
                    nativeStarted.resolve();
                  },
            });
            if (result) {
              return result;
            }
            await delay(10);
          }
          throw new Error("Queue owner did not become ready");
        };
        const first = submit(false);
        void first.catch(() => {});
        let second: ReturnType<typeof submit> | undefined;
        try {
          await withTimeout(Promise.race([accepted.promise, first]), 5000);
          second = submit(true);
          void second.catch(() => {});
          await withTimeout(Promise.race([successorAccepted.promise, second]), 5000);
          if (mode !== "gap") {
            const ready =
              mode === "backoff"
                ? retryError.promise
                : mode === "settled"
                  ? drainEntered.promise
                  : nativeStarted.promise;
            await withTimeout(Promise.race([ready, first]), 5000);
            assert.equal(
              await tryCancelOnRunningOwner({
                sessionId: record.acpxRecordId,
                targetRequestId: "cancel-target",
              }),
              true,
            );
          }
          releaseDrain.resolve();
          if (mode === "fatal") {
            await assert.rejects(first, /Invalid params|synthetic fatal/);
          } else {
            const result = await first;
            assert.ok("stopReason" in result);
            assert.equal(result.stopReason, mode === "settled" ? "max_tokens" : "cancelled");
            if (mode === "settled" || mode === "cooperative") {
              assert.deepEqual(result._meta, {
                proof: mode === "settled" ? "settled-response" : "cooperative-response",
              });
            }
          }
          const next = await second;
          assert.ok("stopReason" in next);
          assert.equal(next.stopReason, "end_turn");
        } finally {
          releaseDrain.resolve();
          await withTimeout(owner, 15000);
        }
        assert.equal(promptWrites, mode === "gap" ? 0 : 1);
        const requests = (await fs.readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as PeerRequest);
        assert.equal(
          requests.filter(
            (request) =>
              request.method === "session/prompt" && request.params?.prompt?.[0]?.text === mode,
          ).length,
          mode === "gap" ? 0 : 1,
        );
        assert.equal(
          requests.filter(
            (request) =>
              request.method === "session/prompt" &&
              request.params?.prompt?.[0]?.text === "successor",
          ).length,
          1,
        );
        assert.equal(
          requests.some((request) => request.method === "session/new"),
          false,
        );
        if (["active-error", "cooperative", "fatal"].includes(mode)) {
          assert.ok(requests.some((request) => request.method === "session/cancel"));
        }
        for (const pid of new Set(requests.map((request) => request.pid))) {
          assert.equal(isProcessAlive(pid), false);
        }
        const saved = await resolveSessionRecord(record.acpxRecordId);
        assert.equal(saved.acpSessionId, record.acpSessionId);
        if (mode === "settled") {
          assert.equal(saved.cumulative_token_usage.input_tokens, 9);
        }
        for await (const event of watchSession({
          record: saved,
          signal: AbortSignal.timeout(5000),
        })) {
          if (event.type === "turn_result" && event.requestId === "cancel-target") {
            assert.equal(
              event.result.status,
              mode === "settled" ? "completed" : mode === "fatal" ? "failed" : "cancelled",
            );
            return;
          }
        }
        assert.fail("Missing cancelled turn journal result");
      });
    },
  );
}
