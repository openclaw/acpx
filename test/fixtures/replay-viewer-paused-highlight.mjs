import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationMessage } from "../../examples/flows/replay-viewer/src/components/inspector/conversation-message.tsx";
import { resolveSessionRenderState } from "../../examples/flows/replay-viewer/src/lib/session-render-state.ts";
import {
  listSessionViews,
  selectAttemptView,
} from "../../examples/flows/replay-viewer/src/lib/view-model-conversation.ts";

const scenario = process.argv[2];
const observations = [];
const conversationTexts = ["FIRST-PROMPT", "FIRST-REPLY", "SECOND-PROMPT", "SECOND-REPLY"];

function makeBundle() {
  const at = "2026-01-01T00:00:00.000Z";
  const binding = {
    key: "main:/tmp/synthetic-paused-highlight",
    handle: "main",
    bundleId: "main",
    name: "main",
    agentName: "fixture",
    agentCommand: "synthetic-agent",
    cwd: "/tmp/synthetic-paused-highlight",
    acpxRecordId: "synthetic-record",
    acpSessionId: "synthetic-session",
  };
  const steps = ["first", "second"].map((nodeId, index) => ({
    attemptId: `${nodeId}#1`,
    nodeId,
    nodeType: "acp",
    outcome: "ok",
    startedAt: at,
    finishedAt: "2026-01-01T00:00:01.000Z",
    promptText: conversationTexts[index * 2],
    rawText: conversationTexts[index * 2 + 1],
    output: null,
    session: binding,
    agent: {
      agentName: "fixture",
      agentCommand: "synthetic-agent",
      cwd: binding.cwd,
    },
    trace: {
      sessionId: "main",
      conversation: {
        sessionId: "main",
        messageStart: index * 2,
        messageEnd: index * 2 + 1,
        eventStartSeq: index * 2 + 1,
        eventEndSeq: index * 2 + 2,
      },
    },
  }));
  steps.push({
    attemptId: "finish#1",
    nodeId: "finish",
    nodeType: "compute",
    outcome: "ok",
    startedAt: at,
    finishedAt: "2026-01-01T00:00:01.000Z",
    promptText: null,
    rawText: null,
    output: { finished: true },
    session: null,
    agent: null,
  });
  return {
    steps,
    trace: [],
    sessions: {
      main: {
        id: "main",
        binding,
        record: {
          cwd: binding.cwd,
          agentCommand: binding.agentCommand,
          name: "main",
          messages: conversationTexts.map((text, index) =>
            index % 2 === 0
              ? { User: { id: `user-${index}`, content: [{ Text: text }] } }
              : { Agent: { content: [{ Text: text }], tool_results: {} } },
          ),
        },
        events: [],
      },
    },
  };
}

function renderPaused(bundle, stepIndex, sessionId = "main") {
  const selected = selectAttemptView(bundle, stepIndex);
  assert.ok(selected);
  const session = listSessionViews(bundle, selected).find((entry) => entry.id === sessionId);
  assert.ok(session);
  const state = resolveSessionRenderState({
    sessionSlice: session.sessionSlice,
    isStreamingSource: session.isStreamingSource,
    sessionRevealProgress: null,
    liveStreaming: false,
  });
  assert.equal(state.animateConversation, false);
  assert.equal(state.autoFollowConversation, false);
  assert.deepEqual(state.renderedSessionSlice, session.sessionSlice);
  const messages = state.renderedSessionSlice;
  const markup = messages.map((message) =>
    renderToStaticMarkup(createElement(ConversationMessage, { message, animate: false })),
  );
  return { selected, session, messages, markup };
}

function articleAttributes(markup) {
  const match = /^<article\b([^>]*)>/.exec(markup);
  assert.ok(match, "each message must retain its article element");
  return match[1];
}

function selectedIndexes(rendered) {
  return rendered.markup.flatMap((markup, index) =>
    articleAttributes(markup).includes("selected ACP slice") ? [index] : [],
  );
}

function assertSelectedRange(rendered, expected) {
  assert.deepEqual(selectedIndexes(rendered), expected);
  for (const [index, markup] of rendered.markup.entries()) {
    const message = rendered.messages[index];
    const attributes = articleAttributes(markup);
    if (expected.includes(index)) {
      assert.ok(attributes.includes(`aria-label="${message.title} — selected ACP slice"`));
    } else {
      assert.doesNotMatch(attributes, /selected ACP slice|conversation__message--highlighted/);
    }
    assert.ok(attributes.includes(`conversation__message--${message.role}`));
  }
  observations.push({
    step: rendered.selected.step.nodeId,
    session: rendered.session.id,
    selectedIndexes: selectedIndexes(rendered),
    messageCount: rendered.messages.length,
  });
}

function assertAllConversationText(rendered) {
  assert.equal(rendered.messages.length, conversationTexts.length);
  for (const [index, text] of conversationTexts.entries()) {
    assert.deepEqual(rendered.messages[index].textBlocks, [text]);
    assert.ok(rendered.markup[index].includes(`<p>${text}</p>`));
  }
}

function messageBodies(rendered) {
  return rendered.markup.map((markup) => markup.slice(markup.indexOf(">") + 1));
}

if (scenario === "first-second-back") {
  const bundle = makeBundle();
  const first = renderPaused(bundle, 0);
  assertSelectedRange(first, [0, 1]);
  assertAllConversationText(first);
  const second = renderPaused(bundle, 1);
  assertSelectedRange(second, [2, 3]);
  assertAllConversationText(second);
  assert.deepEqual(messageBodies(second), messageBodies(first));
  const back = renderPaused(bundle, 0);
  assertSelectedRange(back, [0, 1]);
  assertAllConversationText(back);
  assert.deepEqual(back.markup, first.markup);
} else if (scenario === "non-acp-fallback") {
  const bundle = makeBundle();
  const direct = renderPaused(bundle, 1);
  const fallback = renderPaused(bundle, 2);
  assert.equal(fallback.selected.sessionFromFallback, true);
  assert.equal(fallback.selected.sessionSourceStep.attemptId, bundle.steps[1].attemptId);
  assert.equal(fallback.session.isStreamingSource, false);
  assertSelectedRange(fallback, [2, 3]);
  assertAllConversationText(fallback);
  assert.deepEqual(fallback.markup, direct.markup);
} else if (scenario === "unrelated-no-range") {
  const bundle = makeBundle();
  bundle.sessions.other = {
    id: "other",
    binding: { ...bundle.sessions.main.binding, bundleId: "other", handle: "other", name: "other" },
    record: {
      cwd: "/tmp/synthetic-paused-highlight",
      agentCommand: "synthetic-agent",
      name: "other",
      messages: [
        { User: { id: "other-user", content: [{ Text: "OTHER-PROMPT" }] } },
        { Agent: { content: [{ Text: "OTHER-REPLY" }], tool_results: {} } },
      ],
    },
    events: [],
  };
  const unrelated = renderPaused(bundle, 0, "other");
  assert.equal(unrelated.session.isStreamingSource, false);
  assertSelectedRange(unrelated, []);
  assert.deepEqual(
    unrelated.messages.map((message) => message.textBlocks),
    [["OTHER-PROMPT"], ["OTHER-REPLY"]],
  );
  delete bundle.steps[0].trace.conversation;
  const noRange = renderPaused(bundle, 0);
  assert.equal(noRange.selected.sessionRecord, bundle.sessions.main.record);
  assertSelectedRange(noRange, []);
  assertAllConversationText(noRange);
} else if (scenario === "tool-only") {
  const bundle = makeBundle();
  bundle.sessions.main.record.messages[3] = {
    Agent: {
      content: [
        {
          ToolUse: {
            id: "synthetic-tool",
            name: "Inspect fixture",
            input: { command: ["printf", "SYNTHETIC-TOOL-RESULT"] },
            is_input_complete: true,
          },
        },
      ],
      tool_results: {
        "synthetic-tool": {
          tool_use_id: "synthetic-tool",
          tool_name: "Inspect fixture",
          is_error: false,
          output: { status: "completed", formatted_output: "SYNTHETIC-TOOL-RESULT" },
        },
      },
    },
  };
  const rendered = renderPaused(bundle, 1);
  assertSelectedRange(rendered, [2, 3]);
  const toolOnly = rendered.messages[3];
  assert.deepEqual(toolOnly.textBlocks, []);
  assert.deepEqual(
    toolOnly.parts.map((part) => part.type),
    ["tool_use", "tool_result"],
  );
  assert.equal(rendered.messages.length, 4);
  assert.ok(rendered.markup[0].includes("FIRST-PROMPT"));
  assert.ok(rendered.markup[1].includes("FIRST-REPLY"));
  assert.ok(rendered.markup[3].includes("Inspect fixture"));
  assert.ok(rendered.markup[3].includes("SYNTHETIC-TOOL-RESULT"));
  assert.equal([...rendered.markup[3].matchAll(/<details\b/g)].length, 2);
  assert.doesNotMatch(rendered.markup[3], /<details\b[^>]*\bopen(?:\s|=|>)/);
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, ok: true, observations }));
