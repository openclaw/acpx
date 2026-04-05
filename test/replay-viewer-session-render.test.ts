import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionRenderState } from "../examples/flows/replay-viewer/src/lib/session-render-state.js";
import type { SelectedAttemptView } from "../examples/flows/replay-viewer/src/lib/view-model-types.js";

test("resolveSessionRenderState keeps live tool calls and results visible while a run is streaming", () => {
  const sessionSlice = makeSessionSlice();

  const rendered = resolveSessionRenderState({
    sessionSlice,
    isStreamingSource: true,
    sessionRevealProgress: 0.25,
    liveStreaming: true,
  });

  assert.equal(rendered.animateConversation, false);
  assert.equal(rendered.autoFollowConversation, true);
  assert.deepEqual(rendered.renderedSessionSlice, sessionSlice);
  assert.equal(rendered.renderedSessionSlice[1]?.toolUses.length, 1);
  assert.equal(rendered.renderedSessionSlice[1]?.toolResults.length, 1);
});

test("resolveSessionRenderState replays tool calls before the step fully completes", () => {
  const sessionSlice = makeSessionSlice();

  const rendered = resolveSessionRenderState({
    sessionSlice,
    isStreamingSource: true,
    sessionRevealProgress: 0.8,
    liveStreaming: false,
  });

  assert.equal(rendered.animateConversation, true);
  assert.equal(rendered.autoFollowConversation, true);
  assert.notDeepEqual(rendered.renderedSessionSlice, sessionSlice);
  assert.equal(rendered.renderedSessionSlice[1]?.toolUses.length ?? 0, 1);
});

function makeSessionSlice(): SelectedAttemptView["sessionSlice"] {
  return [
    {
      index: 0,
      role: "user",
      title: "User",
      highlighted: true,
      textBlocks: ["Please inspect the PR."],
      toolUses: [],
      toolResults: [],
      hiddenPayloads: [],
      parts: [{ type: "text", text: "Please inspect the PR." }],
    },
    {
      index: 1,
      role: "agent",
      title: "Agent",
      highlighted: true,
      textBlocks: ["Running checks and collecting context."],
      toolUses: [
        {
          id: "tool-1",
          name: "shell",
          summary: "rg -n session src",
          raw: { name: "shell", input: "rg -n session src" },
        },
      ],
      toolResults: [
        {
          id: "tool-1",
          toolName: "shell",
          status: "ok",
          preview: "src/cli/session/runtime.ts:12",
          isError: false,
          raw: { output: "src/cli/session/runtime.ts:12" },
        },
      ],
      hiddenPayloads: [],
      parts: [
        { type: "text", text: "Running checks and collecting context." },
        {
          type: "tool_use",
          toolUse: {
            id: "tool-1",
            name: "shell",
            summary: "rg -n session src",
            raw: { name: "shell", input: "rg -n session src" },
          },
        },
        {
          type: "tool_result",
          toolResult: {
            id: "tool-1",
            toolName: "shell",
            status: "ok",
            preview: "src/cli/session/runtime.ts:12",
            isError: false,
            raw: { output: "src/cli/session/runtime.ts:12" },
          },
        },
      ],
    },
  ];
}
