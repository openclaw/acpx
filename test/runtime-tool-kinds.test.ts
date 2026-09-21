import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification, ToolKind } from "@agentclientprotocol/sdk";
import { parsePromptEventLine } from "../src/runtime/public/events.js";

const sdk = (await import(
  new URL("./schema/zod.gen.js", import.meta.resolve("@agentclientprotocol/sdk")).href
)) as { zSessionNotification: { parse(value: unknown): SessionNotification } };

// Record<ToolKind, true> makes an SDK enum addition require an explicit test case.
const legalKinds: Record<ToolKind, true> = {
  read: true,
  edit: true,
  delete: true,
  move: true,
  search: true,
  execute: true,
  think: true,
  fetch: true,
  switch_mode: true,
  other: true,
};

function project(notification: unknown) {
  return parsePromptEventLine(
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: notification }),
  );
}

for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
  for (const kind of Object.keys(legalKinds) as ToolKind[]) {
    test(`${sessionUpdate} preserves SDK tool kind ${kind}`, () => {
      const status = sessionUpdate === "tool_call" ? "in_progress" : "completed";
      const toolCallId = `fixture-${kind}`;
      const validated = sdk.zSessionNotification.parse({
        sessionId: "fixture-session",
        update: { sessionUpdate, toolCallId, title: "Synthetic tool", status, kind },
      });
      assert.equal("kind" in validated.update ? validated.update.kind : undefined, kind);
      const event = project(validated);
      assert.ok(event?.type === "tool_call");
      assert.equal(event.kind, kind);
      assert.equal(event.tag, sessionUpdate);
      assert.equal(event.toolCallId, toolCallId);
      assert.equal(event.title, "Synthetic tool");
      assert.equal(event.status, status);
    });
  }

  for (const { label, kind } of [
    { label: "absent", kind: undefined },
    { label: "unknown string", kind: "future_unknown_kind" },
    { label: "null", kind: null },
    { label: "number", kind: 42 },
  ]) {
    test(`${sessionUpdate} omits ${label} kind without dropping the event`, () => {
      // An SDK parse could erase the unknown value and hide a projection defect.
      const event = project({
        sessionId: "fixture-session",
        update: {
          sessionUpdate,
          toolCallId: "fixture-unknown-kind",
          title: "Synthetic tool",
          status: "completed",
          ...(kind === undefined ? {} : { kind }),
        },
      });
      assert.ok(event?.type === "tool_call");
      assert.equal(Object.hasOwn(event, "kind"), false);
      assert.equal(event.tag, sessionUpdate);
      assert.equal(event.toolCallId, "fixture-unknown-kind");
      assert.equal(event.title, "Synthetic tool");
      assert.equal(event.status, "completed");
    });
  }
}
