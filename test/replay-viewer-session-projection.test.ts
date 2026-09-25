import assert from "node:assert/strict";
import test from "node:test";
import {
  projectConversationRange,
  projectSession,
  type ProjectionInterval,
  type SessionProjection,
} from "../examples/flows/replay-viewer/src/lib/session-projection.js";
import type {
  FlowBundledSessionEvent,
  SessionRecord,
} from "../examples/flows/replay-viewer/src/types.js";
import type { SessionMessage } from "../src/types.js";

const SESSION_ID = "projection-session";
const TIMESTAMP = "2026-09-25T12:00:00.000Z";
const LAST_ANSWER = `${"long answer ".repeat(750)}recoverable final marker`;

test("a nonempty checkpoint without a cursor preserves saved content without claiming events", () => {
  const fixture = completedTurnFixture();
  delete fixture.record.lastSeq;
  const events = [
    ...fixture.events,
    promptEvent(3, "unpositioned question"),
    chunkEvent(4, "unpositioned answer"),
    updateEvent(5, { sessionUpdate: "usage_update", outputTokens: 99 }),
  ];
  const intervals = [...fixture.intervals, { eventStartSeq: 3, eventEndSeq: 5 }];
  const untouched = structuredClone({ record: fixture.record, events, intervals });
  const projected = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);

  assert.deepEqual(projected.record.messages, fixture.record.messages);
  assert.deepEqual(projected.record.request_token_usage, fixture.record.request_token_usage);
  assert.deepEqual(projected.record.cumulative_token_usage, fixture.record.cumulative_token_usage);
  assert.equal(projected.record.lastSeq, undefined);
  assert.equal(projected.eventMessages.size, 0);
  assert.equal(
    projectConversationRange(projected, { ...trace(1, 2), messageStart: 0, messageEnd: 1 })
      .messageEnd,
    -1,
  );
  assert.equal(projectConversationRange(projected, trace(3, 5)).messageEnd, -1);
  assert.deepEqual({ record: fixture.record, events, intervals }, untouched);
});

for (const includeHistory of [false, true]) {
  for (const includeAcceptedPrefix of [false, true]) {
    test(`a tail gap ${includeAcceptedPrefix ? "after an accepted prefix" : "at the checkpoint boundary"} stops replay with ${includeHistory ? "captured" : "no captured"} history`, () => {
      const fixture = completedTurnFixture();
      const history = includeHistory ? fixture.events : [];
      const accepted = includeAcceptedPrefix ? [chunkEvent(3, " accepted tail")] : [];
      const nextPromptSeq = includeAcceptedPrefix ? 5 : 4;
      const events = [
        ...history,
        ...accepted,
        promptEvent(nextPromptSeq, "unaccepted question"),
        chunkEvent(nextPromptSeq + 1, "unaccepted answer"),
      ];
      const intervals = [
        ...fixture.intervals,
        { eventStartSeq: 3, eventEndSeq: 3 },
        { eventStartSeq: nextPromptSeq, eventEndSeq: nextPromptSeq + 1 },
      ];
      const untouched = structuredClone({ record: fixture.record, events, intervals });
      const projected = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
      const acceptedOnly = projectSession(
        SESSION_ID,
        fixture.record,
        [...history, ...accepted],
        intervals,
        TIMESTAMP,
      );

      assert.deepEqual(projected, acceptedOnly);
      assert.equal(projected.record.lastSeq, includeAcceptedPrefix ? 3 : 2);
      assert.equal(
        agentText(projected.record, 1),
        includeAcceptedPrefix ? "previous answer accepted tail" : "previous answer",
      );
      assert.equal(projected.eventMessages.has(3), includeAcceptedPrefix);
      assert.equal(projected.eventMessages.has(nextPromptSeq), false);
      assert.equal(projected.eventMessages.has(nextPromptSeq + 1), false);
      assert.equal(
        projectConversationRange(projected, trace(nextPromptSeq, nextPromptSeq + 1)).messageEnd,
        -1,
      );
      assert.deepEqual({ record: fixture.record, events, intervals }, untouched);
    });
  }
}

test("a prompt beyond a gap cannot claim earlier pending setup through lookahead", () => {
  const fixture = completedTurnFixture();
  const accepted = chunkEvent(3, " unowned setup");
  const events = [
    ...fixture.events,
    accepted,
    promptEvent(5, "unaccepted question"),
    chunkEvent(6, "unaccepted answer"),
  ];
  const pending: ProjectionInterval = { eventStartSeq: 3, eventEndSeq: 6, pending: true };
  const intervals = [...fixture.intervals, pending];
  const untouched = structuredClone({ record: fixture.record, events, intervals });
  const projected = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
  const acceptedOnly = projectSession(
    SESSION_ID,
    fixture.record,
    [...fixture.events, accepted],
    intervals,
    TIMESTAMP,
  );

  assert.deepEqual(projected, acceptedOnly);
  assert.deepEqual(projected.record.messages, fixture.record.messages);
  assert.deepEqual(projected.record.request_token_usage, fixture.record.request_token_usage);
  assert.equal(projected.record.lastSeq, 3);
  assert.equal(projected.eventMessages.has(3), false);
  assert.equal(projected.eventMessages.has(5), false);
  assert.equal(projected.eventMessages.has(6), false);
  assert.equal(projectConversationRange(projected, trace(3, 6)).messageEnd, -1);
  assert.deepEqual({ record: fixture.record, events, intervals }, untouched);
});

test("a malformed tail preserves reconstructed history and the accepted tail prefix", () => {
  const fixture = historicalFixture();
  const accepted = acceptedTail();
  const events = [
    ...fixture.events,
    ...accepted,
    updateEvent(205, { sessionUpdate: "available_commands_update" }),
    promptEvent(206, "unaccepted next turn"),
    chunkEvent(207, "unaccepted next answer"),
  ];
  const intervals = [
    ...fixture.intervals,
    { eventStartSeq: 203, eventEndSeq: 204 },
    { eventStartSeq: 205, eventEndSeq: 207 },
  ];
  const untouched = structuredClone({ record: fixture.record, events, intervals });
  const projected = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
  const acceptedOnly = projectSession(
    SESSION_ID,
    fixture.record,
    [...fixture.events, ...accepted],
    intervals,
    TIMESTAMP,
  );

  assert.deepEqual(projected, acceptedOnly);
  assertRecoveredHistory(projected);
  assert.equal(projected.record.lastSeq, 204);
  assert.equal(agentText(projected.record, 201), `${LAST_ANSWER} accepted tail`);
  assert.equal(projected.record.cumulative_token_usage?.output_tokens, 17);
  assert.equal(projected.record.request_token_usage?.["checkpoint-turn-100"]?.output_tokens, 17);
  assert.equal(projected.eventMessages.get(203), 201);
  assert.equal(projected.eventMessages.has(204), false);
  assert.equal(projected.eventMessages.has(206), false);
  assert.equal(projectConversationRange(projected, trace(205, 207)).messageEnd, -1);
  assert.deepEqual({ record: fixture.record, events, intervals }, untouched);
});

for (const [label, invalid] of [
  ["a repeated tail sequence", promptEvent(203, "duplicate tail prompt")],
  ["an old historical prompt", promptEvent(1, "question 0")],
  ["an invalid sequence", chunkEvent(-1, "invalid sequence")],
] as const) {
  test(`${label} cannot invalidate checkpoint correspondence or accepted tail content`, () => {
    const fixture = historicalFixture();
    const accepted = chunkEvent(203, " accepted tail");
    const events = [...fixture.events, accepted, invalid, chunkEvent(204, "unaccepted suffix")];
    const intervals = [...fixture.intervals, { eventStartSeq: 203, eventEndSeq: 204 }];
    const projected = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
    const acceptedOnly = projectSession(
      SESSION_ID,
      fixture.record,
      [...fixture.events, accepted],
      intervals,
      TIMESTAMP,
    );

    assert.deepEqual(projected, acceptedOnly);
    assertRecoveredHistory(projected);
    assert.equal(projected.record.lastSeq, 203);
    assert.equal(agentText(projected.record, 201), `${LAST_ANSWER} accepted tail`);
    assert.equal(projected.eventMessages.get(203), 201);
    assert.equal(projected.eventMessages.has(204), false);
  });
}

test("an old prompt immediately after the checkpoint is rejected as tail data", () => {
  const fixture = historicalFixture();
  const projected = projectSession(
    SESSION_ID,
    fixture.record,
    [...fixture.events, promptEvent(1, "question 0"), chunkEvent(203, "unaccepted suffix")],
    fixture.intervals,
    TIMESTAMP,
  );

  assertRecoveredHistory(projected);
  assert.equal(projected.record.lastSeq, 202);
  assert.equal(agentText(projected.record, 201), LAST_ANSWER);
  assert.equal(projected.eventMessages.has(203), false);
});

test("an invalid leading event cannot disguise present history as checkpoint-only", () => {
  const fixture = historicalFixture();
  const projected = projectSession(
    SESSION_ID,
    fixture.record,
    [chunkEvent(0, "invalid leading event"), ...fixture.events],
    fixture.intervals,
    TIMESTAMP,
  );
  assert.equal(projected.checkpointMode, "unmatched");
  assert.deepEqual(projected.record.messages, fixture.record.messages);
  assert.equal(projected.eventMessages.size, 0);
  assert.equal(projectConversationRange(projected, trace(1, 2)).messageEnd, -1);
});

test("an opaque checkpoint keeps accepted suffix events when a later envelope fails", () => {
  const fixture = historicalFixture();
  const projected = projectSession(
    SESSION_ID,
    fixture.record,
    [
      chunkEvent(203, " accepted tail"),
      updateEvent(204, { sessionUpdate: "available_commands_update" }),
      chunkEvent(205, "unaccepted suffix"),
    ],
    [{ eventStartSeq: 203, eventEndSeq: 205 }],
    TIMESTAMP,
  );

  assert.equal(projected.checkpointMode, "opaque");
  assert.equal(projected.record.messages?.length, 200);
  assert.equal(projected.record.lastSeq, 203);
  assert.equal(agentText(projected.record, 199), `${LAST_ANSWER.slice(0, 7_997)}... accepted tail`);
  assert.equal(projected.eventMessages.get(203), 199);
});

for (const problem of [
  "different checkpoint content",
  "unassigned prompt",
  "missing event",
] as const) {
  test(`tail recovery does not adopt historical IDs with ${problem}`, () => {
    const fixture = historicalFixture();
    if (problem === "different checkpoint content") {
      fixture.record.messages![0] = {
        User: { id: "checkpoint-turn-1", content: [{ Text: "different checkpoint content" }] },
      };
    } else if (problem === "unassigned prompt") {
      fixture.intervals.shift();
    } else {
      fixture.events.shift();
    }
    const projected = projectSession(
      SESSION_ID,
      fixture.record,
      [
        ...fixture.events,
        chunkEvent(203, " accepted tail"),
        updateEvent(204, { sessionUpdate: "available_commands_update" }),
      ],
      [...fixture.intervals, { eventStartSeq: 203, eventEndSeq: 204 }],
      TIMESTAMP,
    );

    assert.equal(projected.checkpointMode, "unmatched");
    assert.equal(projected.record.messages?.length, 200);
    assert.deepEqual(projected.record.messages?.[0], fixture.record.messages?.[0]);
    assert.equal(projected.record.lastSeq, 203);
    assert.equal(
      agentText(projected.record, 199),
      `${LAST_ANSWER.slice(0, 7_997)}... accepted tail`,
    );
    assert.equal(projected.eventMessages.has(1), false);
    assert.equal(projected.eventMessages.get(203), 199);
    assert.equal(projectConversationRange(projected, trace(3, 4)).messageEnd, -1);
  });
}

test("pending setup leaves the previous answer and usage unclaimed until a prompt is captured", () => {
  const fixture = completedTurnFixture();
  const events = [
    ...fixture.events,
    chunkEvent(3, " setup"),
    updateEvent(4, { sessionUpdate: "usage_update", outputTokens: 99 }),
  ];
  const pending: ProjectionInterval = { eventStartSeq: 3, eventEndSeq: 4, pending: true };
  const untouched = structuredClone({ record: fixture.record, events, pending });
  const projected = projectSession(
    SESSION_ID,
    fixture.record,
    events,
    [...fixture.intervals, pending],
    TIMESTAMP,
  );

  assert.equal(projected.checkpointMode, "reconstructed");
  assert.deepEqual(projected.record.messages, fixture.record.messages);
  assert.deepEqual(projected.record.request_token_usage, fixture.record.request_token_usage);
  assert.deepEqual(projected.record.cumulative_token_usage, fixture.record.cumulative_token_usage);
  assert.deepEqual(projectConversationRange(projected, trace(1, 2)), {
    ...trace(1, 2),
    messageStart: 0,
    messageEnd: 1,
  });
  assert.equal(projectConversationRange(projected, trace(3, 4)).messageEnd, -1);
  assert.equal(projected.eventMessages.has(3), false);
  assert.deepEqual({ record: fixture.record, events, pending }, untouched);
});

for (const emptyPrompt of [false, true]) {
  test(`a later ${emptyPrompt ? "empty" : "nonempty"} prompt resolves pending setup ownership`, () => {
    const fixture = completedTurnFixture();
    const prompt = promptEvent(5, "next question");
    if (emptyPrompt) {
      prompt.message.params = { sessionId: "agent-session", prompt: [] };
    }
    const events = [
      ...fixture.events,
      chunkEvent(3, " setup"),
      updateEvent(4, { sessionUpdate: "usage_update", outputTokens: 99 }),
      prompt,
      chunkEvent(6, " answer"),
    ];
    const pending: ProjectionInterval = { eventStartSeq: 3, eventEndSeq: 6, pending: true };
    const projected = projectSession(
      SESSION_ID,
      fixture.record,
      events,
      [...fixture.intervals, pending],
      TIMESTAMP,
    );

    assert.equal(projected.checkpointMode, "reconstructed");
    assert.deepEqual(projected.record.messages?.[0], fixture.record.messages?.[0]);
    assert.deepEqual(projectConversationRange(projected, trace(1, 2)), {
      ...trace(1, 2),
      messageStart: 0,
      messageEnd: 1,
    });
    if (emptyPrompt) {
      assert.equal(projected.record.messages?.length, 2);
      assert.equal(agentText(projected.record, 1), "previous answer setup answer");
      assert.equal(projected.eventMessages.has(5), false);
      assert.equal(
        projected.record.request_token_usage?.["saved-previous-user"]?.output_tokens,
        99,
      );
      assert.deepEqual(projectConversationRange(projected, trace(3, 6)), {
        ...trace(3, 6),
        messageStart: 1,
        messageEnd: 1,
      });
    } else {
      assert.equal(projected.record.messages?.length, 4);
      assert.equal(agentText(projected.record, 1), "previous answer");
      assert.deepEqual(projected.record.messages?.[2], {
        User: { id: `replay:${SESSION_ID}:5`, content: [{ Text: "next question" }] },
      });
      assert.equal(agentText(projected.record, 3), " setup answer");
      assert.equal(projected.record.request_token_usage?.["saved-previous-user"]?.output_tokens, 5);
      assert.equal(
        projected.record.request_token_usage?.[`replay:${SESSION_ID}:5`]?.output_tokens,
        99,
      );
      assert.deepEqual(projectConversationRange(projected, trace(3, 6)), {
        ...trace(3, 6),
        messageStart: 2,
        messageEnd: 3,
      });
    }
  });
}

test("a notification-only User boundary unlocks pending updates and preserves identities", () => {
  const fixture = completedTurnFixture();
  const events = [
    ...fixture.events,
    chunkEvent(3, " ambiguous setup"),
    updateEvent(4, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "notification question" },
    }),
    chunkEvent(5, "notification answer"),
  ];
  const intervals: ProjectionInterval[] = [
    ...fixture.intervals,
    { eventStartSeq: 3, eventEndSeq: 6, pending: true },
  ];
  const first = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
  const user = {
    User: { id: `replay:${SESSION_ID}:4`, content: [{ Text: "notification question" }] },
  };

  assert.equal(first.record.messages?.length, 4);
  assert.equal(agentText(first.record, 1), "previous answer");
  assert.deepEqual(first.record.messages?.[2], user);
  assert.equal(first.eventMessages.has(3), false);
  assert.deepEqual(projectConversationRange(first, trace(3, 5)), {
    ...trace(3, 5),
    messageStart: 2,
    messageEnd: 3,
  });
  assert.deepEqual(projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP), first);

  events.push(chunkEvent(6, " continued"));
  const grown = projectSession(SESSION_ID, fixture.record, events, intervals, TIMESTAMP);
  assert.deepEqual(grown.record.messages?.[2], user);
  assert.equal(agentText(grown.record, 3), "notification answer continued");

  const checkpoint = structuredClone(grown.record);
  checkpoint.messages![2] = { User: { ...user.User, id: "saved-notification-user" } };
  const restored = projectSession(SESSION_ID, checkpoint, events, intervals, TIMESTAMP);
  assert.equal(restored.checkpointMode, "reconstructed");
  assert.deepEqual(restored.record.messages, checkpoint.messages);
  assert.equal(restored.eventMessages.has(3), false);
});

for (const direction of ["inbound", "outbound"] as const) {
  test(`an ${direction} unsupported User envelope does not unlock pending agent content`, () => {
    const fixture = completedTurnFixture();
    const notification = updateEvent(3, {
      sessionUpdate: "user_message_chunk",
      content: { type: direction === "inbound" ? "unsupported" : "text", text: "not a boundary" },
    });
    notification.direction = direction;
    const projected = projectSession(
      SESSION_ID,
      fixture.record,
      [...fixture.events, notification, chunkEvent(4, " ambiguous setup")],
      [...fixture.intervals, { eventStartSeq: 3, eventEndSeq: 4, pending: true }],
      TIMESTAMP,
    );

    assert.deepEqual(projected.record.messages, fixture.record.messages);
    assert.equal(projectConversationRange(projected, trace(3, 4)).messageEnd, -1);
  });
}

test("metadata-only and empty pending intervals never borrow the preceding turn", () => {
  const fixture = completedTurnFixture();
  const prepared = projectSession(
    SESSION_ID,
    fixture.record,
    fixture.events,
    [...fixture.intervals, { eventStartSeq: 3, eventEndSeq: 2, pending: true }],
    TIMESTAMP,
  );
  assert.equal(projectConversationRange(prepared, trace(3, 2)).messageEnd, -1);
  const metadata = projectSession(
    SESSION_ID,
    fixture.record,
    [
      ...fixture.events,
      updateEvent(3, { sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    ],
    [...fixture.intervals, { eventStartSeq: 3, eventEndSeq: 3, pending: true }],
    TIMESTAMP,
  );
  assert.deepEqual(metadata.record.messages, fixture.record.messages);
  assert.equal(metadata.record.acpx?.current_mode_id, "plan");
  assert.equal(projectConversationRange(metadata, trace(3, 3)).messageEnd, -1);
});

function completedTurnFixture(): {
  record: SessionRecord;
  events: FlowBundledSessionEvent[];
  intervals: ProjectionInterval[];
} {
  return {
    record: {
      lastSeq: 2,
      messages: [
        { User: { id: "saved-previous-user", content: [{ Text: "previous question" }] } },
        { Agent: { content: [{ Text: "previous answer" }], tool_results: {} } },
      ],
      updated_at: TIMESTAMP,
      cumulative_token_usage: { output_tokens: 5 },
      request_token_usage: { "saved-previous-user": { output_tokens: 5 } },
    },
    events: [promptEvent(1, "previous question"), chunkEvent(2, "previous answer")],
    intervals: [{ eventStartSeq: 1, eventEndSeq: 2 }],
  };
}

function historicalFixture(): {
  record: SessionRecord;
  events: FlowBundledSessionEvent[];
  intervals: ProjectionInterval[];
} {
  const messages: SessionMessage[] = [];
  const events: FlowBundledSessionEvent[] = [];
  const intervals: ProjectionInterval[] = [];
  for (let turn = 0; turn <= 100; turn += 1) {
    const seq = turn * 2 + 1;
    const prompt = `question ${turn}`;
    const answer = turn === 100 ? LAST_ANSWER : `answer ${turn}`;
    events.push(promptEvent(seq, prompt), chunkEvent(seq + 1, answer));
    intervals.push({ eventStartSeq: seq, eventEndSeq: seq + 1 });
    messages.push(
      { User: { id: `checkpoint-turn-${turn}`, content: [{ Text: prompt }] } },
      {
        Agent: {
          content: [{ Text: answer.length > 8_000 ? `${answer.slice(0, 7_997)}...` : answer }],
          tool_results: {},
        },
      },
    );
  }
  return {
    record: {
      lastSeq: 202,
      messages: messages.slice(2),
      title: "checkpoint title",
      updated_at: TIMESTAMP,
      request_token_usage: { "checkpoint-turn-100": { output_tokens: 10 } },
      cumulative_token_usage: { output_tokens: 10 },
    },
    events,
    intervals,
  };
}

function acceptedTail(): FlowBundledSessionEvent[] {
  return [
    chunkEvent(203, " accepted tail"),
    updateEvent(204, { sessionUpdate: "usage_update", outputTokens: 17 }),
  ];
}

function assertRecoveredHistory(projection: SessionProjection): void {
  assert.equal(projection.checkpointMode, "reconstructed");
  assert.equal(projection.record.messages?.length, 202);
  assert.deepEqual(projection.record.messages?.[0], {
    User: { id: `replay:${SESSION_ID}:1`, content: [{ Text: "question 0" }] },
  });
  assert.deepEqual(projection.record.messages?.[200], {
    User: { id: "checkpoint-turn-100", content: [{ Text: "question 100" }] },
  });
  assert.equal(agentText(projection.record, 1), "answer 0");
  assert.deepEqual(projectConversationRange(projection, trace(1, 2)), {
    ...trace(1, 2),
    messageStart: 0,
    messageEnd: 1,
  });
}

function agentText(record: SessionRecord, index: number): string {
  const message = record.messages?.[index] as { Agent: { content: Array<{ Text: string }> } };
  return message.Agent.content[0].Text;
}

function trace(eventStartSeq: number, eventEndSeq: number) {
  return { sessionId: SESSION_ID, eventStartSeq, eventEndSeq, messageStart: 0, messageEnd: -1 };
}

function promptEvent(seq: number, text: string): FlowBundledSessionEvent {
  return {
    seq,
    at: TIMESTAMP,
    direction: "outbound",
    message: {
      jsonrpc: "2.0",
      id: seq,
      method: "session/prompt",
      params: { sessionId: "agent-session", prompt: [{ type: "text", text }] },
    },
  };
}

function chunkEvent(seq: number, text: string): FlowBundledSessionEvent {
  return updateEvent(seq, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function updateEvent(seq: number, update: Record<string, unknown>): FlowBundledSessionEvent {
  return {
    seq,
    at: TIMESTAMP,
    direction: "inbound",
    message: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "agent-session", update },
    },
  };
}
