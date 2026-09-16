import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeAgentCommandInput } from "../src/acp/client-process.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { listSessionEvents } from "../src/session/events.js";
import { sendSession } from "../src/session/execution/queue-owner-runtime.js";
import { watchSession, type SessionWatchEvent } from "../src/session/journal.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { tryCancelOnRunningOwner } from "../src/session/queue/ipc.js";
import {
  readQueueOwnerRecord,
  terminateQueueOwnerForSession,
} from "../src/session/queue/lease-store.js";
import type { AcpJsonRpcMessage, OutputFormatter, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

async function readTurn(record: SessionRecord, requestId: string): Promise<SessionWatchEvent[]> {
  const events: SessionWatchEvent[] = [];
  for await (const event of watchSession({ record, signal: AbortSignal.timeout(10_000) })) {
    if (event.requestId !== requestId) {
      continue;
    }
    events.push(event);
    if (event.type === "turn_result") {
      return events;
    }
  }
  throw new Error(`Missing terminal journal result for ${requestId}`);
}

test(
  "queue journal records settled turns without changing ACP output or retrying failed appends",
  { timeout: 30_000 },
  async () => {
    await withTempHome("acpx-queue-watch-", async (home) => {
      const sessionId = "watched-queue";
      const pidFile = path.join(home, "agent.pid");
      const agent = normalizeAgentCommandInput([
        process.execPath,
        fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
        "--supports-load-session",
        "--pid-file",
        pidFile,
      ]);
      const record = makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: "watched-agent-session",
        ...agent,
        cwd: home,
        eventLog: {
          active_path: "",
          segment_count: 1,
          max_segment_bytes: 1024 * 1024,
          max_segments: 5,
        },
      });
      await writeSessionRecordFile(home, record);
      let ownerPid: number | undefined;
      let agentPid: string | undefined;
      const cases = [
        { requestId: "success", prompt: "echo watched-success", status: "completed", wait: true },
        { requestId: "failure", prompt: "retryable-error-once", status: "failed", wait: true },
        { requestId: "cancel", prompt: "sleep 10000", status: "cancelled", wait: true },
        {
          requestId: "background",
          prompt: "echo watched-background",
          status: "completed",
          wait: false,
        },
        {
          requestId: "background-failure",
          prompt: "partial-retryable-error",
          status: "failed",
          wait: false,
        },
        {
          requestId: "journal-write-failure",
          prompt: "sleep 10000",
          status: "failed",
          wait: true,
        },
      ] as const;
      try {
        for (const entry of cases) {
          const output: AcpJsonRpcMessage[] = [];
          const errors: Array<Parameters<OutputFormatter["onError"]>[0]> = [];
          const formatter: OutputFormatter = {
            setContext() {},
            onAcpMessage(message) {
              output.push(message);
            },
            onError(error) {
              errors.push(error);
            },
            onPermissionEscalation() {},
            flush() {},
          };
          let promptStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            promptStarted = resolve;
          });
          const operation = sendSession({
            sessionId,
            requestId: entry.requestId,
            requireSharedRuntime: true,
            prompt: [{ type: "text", text: entry.prompt }],
            permissionMode: "deny-all",
            outputFormatter: formatter,
            resumePolicy: "same-session-only",
            ttlMs: 60_000,
            waitForCompletion: entry.wait,
            ...(entry.requestId === "cancel" || entry.requestId === "journal-write-failure"
              ? { onPromptStarted: promptStarted }
              : {}),
            queueOwnerArgs: [
              fileURLToPath(new URL("../src/cli.js", import.meta.url)),
              "__queue-owner",
            ],
          });
          void operation.catch(() => {});
          if (entry.requestId === "cancel" || entry.requestId === "journal-write-failure") {
            await Promise.race([
              started,
              operation.then(() => {
                throw new Error("cancel target never started");
              }),
            ]);
            if (entry.requestId === "journal-write-failure") {
              const journalPath = sessionEventActivePath(sessionId);
              await fs.rename(journalPath, `${journalPath}.saved`);
              await fs.mkdir(journalPath);
            }
            assert.equal(
              await tryCancelOnRunningOwner({ sessionId, targetRequestId: entry.requestId }),
              true,
            );
          }
          if (entry.requestId === "journal-write-failure") {
            await assert.rejects(operation, {
              detailCode: "SESSION_JOURNAL_WRITE_FAILED",
              retryable: false,
            });
            assert.equal(
              output.filter((message) => "method" in message && message.method === "session/prompt")
                .length,
              1,
              "a failed terminal append must not replay the prompt",
            );
            continue;
          }
          if (entry.wait && entry.status === "failed") {
            await assert.rejects(operation, /Internal error/);
          } else {
            const result = await operation;
            if (!entry.wait) {
              assert.deepEqual(result, { queued: true, sessionId, requestId: entry.requestId });
            } else {
              assert(!("queued" in result));
              assert.equal(
                result.stopReason,
                entry.status === "cancelled" ? "cancelled" : "end_turn",
              );
            }
          }

          const events = await readTurn(record, entry.requestId);
          assert.equal(events[0].type, "turn_started");
          const terminal = events.at(-1);
          assert(terminal?.type === "turn_result");
          assert.equal(terminal.result.status, entry.status);
          assert.equal(events.filter((event) => event.type === "turn_started").length, 1);
          const messages = events.flatMap((event) =>
            event.type === "message" ? [event.message] : [],
          );
          assert(messages.length > 0, "no-wait and failed turns still journal actual ACP messages");
          assert.deepEqual(output, entry.wait ? messages : []);
          assert.equal(
            errors.length,
            0,
            "an emitted ACP error must not gain a duplicate error envelope",
          );
          if (entry.status === "failed") {
            assert(messages.some((message) => "error" in message));
          }
          const latest = await resolveSessionRecord(sessionId);
          assert.equal(
            latest.lastSeq,
            (await listSessionEvents(sessionId)).length,
            "journal markers must not change raw ACP sequence counts",
          );
          const owner = await readQueueOwnerRecord(sessionId);
          assert.equal(owner?.sessionWatch, true);
          ownerPid ??= owner?.pid;
          assert.equal(owner?.pid, ownerPid);
          agentPid ??= await fs.readFile(pidFile, "utf8");
          assert.equal(await fs.readFile(pidFile, "utf8"), agentPid);
        }
      } finally {
        await terminateQueueOwnerForSession(sessionId);
      }
    });
  },
);
