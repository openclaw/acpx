import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePlaybackPlayhead,
  resolvePlaybackResumeMs,
  resolveSelectedStepIndexAfterBundleUpdate,
} from "../examples/flows/replay-viewer/src/hooks/use-playback-controller.js";
import {
  buildGraph,
  buildGraphLayout,
  buildPlaybackTimeline,
  derivePlaybackPreview,
  deriveRunOutcomeView,
  formatDuration,
  formatJson,
  humanizeIdentifier,
  listSessionViews,
  playbackAnchorMs,
  playbackSelectionMs,
  revealConversationSlice,
  revealConversationTranscript,
  selectAttemptView,
} from "../examples/flows/replay-viewer/src/lib/view-model.js";
import type {
  FlowRunManifest,
  FlowRunState,
  FlowStepRecord,
  LoadedRunBundle,
} from "../examples/flows/replay-viewer/src/types.js";

test("selectAttemptView shapes ACP session content into readable conversation parts", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(step, {});
  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);
  assert.equal(selected.sessionSlice.length, 2);

  const [userMessage, agentMessage] = selected.sessionSlice;
  assert.deepEqual(userMessage?.textBlocks, ["Please inspect the PR diff."]);
  assert.equal(agentMessage?.textBlocks[0], "I am checking the runtime changes now.");
  assert.equal(agentMessage?.toolUses.length, 1);
  assert.match(agentMessage?.toolUses[0]?.summary ?? "", /Read pr\.json/);
  assert.equal(agentMessage?.toolResults.length, 1);
  assert.match(agentMessage?.toolResults[0]?.preview ?? "", /stdout: \{"number": 181\}/);
  assert.deepEqual(
    agentMessage?.parts.map((part) => part.type),
    ["text", "tool_use", "tool_result"],
  );
  assert.equal(selected.rawEventSlice.length, 2);
  assert.equal(selected.traceEvents.length, 1);
});

test("buildGraph infers start terminal and branch semantics across the full definition", () => {
  const load = baseStep("load_pr", "action", "ok");
  load.startedAt = "2026-03-27T07:26:00.000Z";
  load.finishedAt = "2026-03-27T07:26:01.000Z";
  const review = baseStep("review_loop", "acp", "failed");
  review.startedAt = "2026-03-27T07:26:02.000Z";
  review.finishedAt = "2026-03-27T07:26:09.000Z";

  const bundle = makeBundle(review, {
    steps: [load, review],
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "branch-flow",
      startAt: "load_pr",
      nodes: {
        load_pr: { nodeType: "action" },
        review_loop: { nodeType: "acp", session: { handle: "main", isolated: false } },
        check_ci: { nodeType: "action" },
        escalate: { nodeType: "compute" },
      },
      edges: [
        { from: "load_pr", to: "review_loop" },
        {
          from: "review_loop",
          switch: {
            on: "route",
            cases: {
              clear: "check_ci",
              blocked: "escalate",
            },
          },
        },
      ],
    },
  });

  const graph = buildGraph(bundle, 1);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node.data]));

  assert.equal(nodeMap.get("load_pr")?.status, "completed");
  assert.equal(nodeMap.get("load_pr")?.isStart, true);
  assert.equal(nodeMap.get("review_loop")?.status, "active");
  assert.equal(nodeMap.get("review_loop")?.isDecision, true);
  assert.equal(nodeMap.get("review_loop")?.playbackProgress, undefined);
  assert.deepEqual(nodeMap.get("review_loop")?.branchLabels, ["clear", "blocked"]);
  assert.equal(nodeMap.get("check_ci")?.status, "queued");
  assert.equal(nodeMap.get("check_ci")?.isTerminal, true);
  assert.equal(nodeMap.get("escalate")?.status, "queued");
  assert.equal(nodeMap.get("escalate")?.isTerminal, true);
  assert.ok(graph.edges.every((edge) => edge.label == null));
});

test("buildGraph applies playback progress to the active node during preview", () => {
  const load = baseStep("load_pr", "action", "ok");
  load.startedAt = "2026-03-27T07:26:00.000Z";
  load.finishedAt = "2026-03-27T07:26:01.000Z";
  const extract = baseStep("extract_intent", "acp", "ok");
  extract.startedAt = "2026-03-27T07:26:02.000Z";
  extract.finishedAt = "2026-03-27T07:26:20.000Z";

  const bundle = makeBundle(extract, {
    steps: [load, extract],
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "playback-flow",
      startAt: "load_pr",
      nodes: {
        load_pr: { nodeType: "action" },
        extract_intent: { nodeType: "acp", session: { handle: "main", isolated: false } },
      },
      edges: [{ from: "load_pr", to: "extract_intent" }],
    },
  });

  const timeline = buildPlaybackTimeline(bundle);
  const preview = derivePlaybackPreview(timeline, timeline.segments[1]!.startMs + 200);
  const graph = buildGraph(bundle, preview!.activeStepIndex, preview);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node.data]));

  assert.equal(nodeMap.get("load_pr")?.status, "completed");
  assert.equal(nodeMap.get("extract_intent")?.status, "active");
  assert.ok((nodeMap.get("extract_intent")?.playbackProgress ?? 0) > 0);
});

test("buildGraph renders the last completed terminal step as completed instead of active", () => {
  const polish = baseStep("polish", "acp", "ok");
  polish.startedAt = "2026-03-27T07:26:02.000Z";
  polish.finishedAt = "2026-03-27T07:26:20.000Z";
  const finalize = baseStep("finalize", "compute", "ok");
  finalize.startedAt = "2026-03-27T07:26:21.000Z";
  finalize.finishedAt = "2026-03-27T07:26:22.000Z";

  const bundle = makeBundle(finalize, {
    steps: [polish, finalize],
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "terminal-flow",
      startAt: "polish",
      nodes: {
        polish: { nodeType: "acp", session: { handle: "main", isolated: false } },
        finalize: { nodeType: "compute" },
      },
      edges: [{ from: "polish", to: "finalize" }],
    },
  });

  const graph = buildGraph(bundle, 1);
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node.data]));
  const finalEdge = graph.edges.find(
    (edge) => edge.source === "polish" && edge.target === "finalize",
  );

  assert.equal(nodeMap.get("finalize")?.status, "completed");
  assert.equal(nodeMap.get("finalize")?.runOutcomeLabel, "completed");
  assert.equal(nodeMap.get("finalize")?.runOutcomeAccent, "ok");
  assert.equal(nodeMap.get("finalize")?.playbackProgress, undefined);
  assert.equal(finalEdge?.animated, false);
  assert.equal(finalEdge?.style?.stroke, "var(--edge-complete)");
});

test("buildGraph pulls pre-terminal handoff chains toward the bottom automatically", () => {
  const finalize = baseStep("finalize", "compute", "ok");
  finalize.startedAt = "2026-03-27T07:30:00.000Z";
  finalize.finishedAt = "2026-03-27T07:30:01.000Z";

  const bundle = makeBundle(finalize, {
    steps: [finalize],
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "handoff-flow",
      startAt: "judge_solution",
      nodes: {
        judge_solution: { nodeType: "acp", session: { handle: "main", isolated: false } },
        bug_or_feature: { nodeType: "acp", session: { handle: "main", isolated: false } },
        collect_review_state: { nodeType: "action" },
        comment_and_escalate_to_human: {
          nodeType: "acp",
          session: { handle: "main", isolated: false },
        },
        post_escalation_comment: { nodeType: "action" },
        finalize: { nodeType: "compute" },
      },
      edges: [
        {
          from: "judge_solution",
          switch: {
            on: "route",
            cases: {
              continue: "bug_or_feature",
              human: "comment_and_escalate_to_human",
            },
          },
        },
        { from: "bug_or_feature", to: "collect_review_state" },
        { from: "collect_review_state", to: "comment_and_escalate_to_human" },
        { from: "comment_and_escalate_to_human", to: "post_escalation_comment" },
        { from: "post_escalation_comment", to: "finalize" },
      ],
    },
  });

  const graph = buildGraph(bundle, 0);
  const positions = new Map(graph.nodes.map((node) => [node.id, node.position.y]));

  assert.ok(
    (positions.get("comment_and_escalate_to_human") ?? 0) > (positions.get("judge_solution") ?? 0),
  );
  assert.ok(
    (positions.get("post_escalation_comment") ?? 0) >
      (positions.get("comment_and_escalate_to_human") ?? 0),
  );
  assert.ok((positions.get("finalize") ?? 0) > (positions.get("post_escalation_comment") ?? 0));
});

test("buildGraphLayout uses layered routing and sinks terminal chains", async () => {
  const bundle = makeBundle(baseStep("finalize", "compute", "ok"), {
    flow: {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "layout-flow",
      startAt: "judge_solution",
      nodes: {
        judge_solution: { nodeType: "acp", session: { handle: "main", isolated: false } },
        bug_or_feature: { nodeType: "acp", session: { handle: "main", isolated: false } },
        check_initial_conflicts: { nodeType: "action" },
        judge_initial_conflicts: {
          nodeType: "acp",
          session: { handle: "main", isolated: false },
        },
        comment_and_escalate_to_human: {
          nodeType: "acp",
          session: { handle: "main", isolated: false },
        },
        post_escalation_comment: { nodeType: "action" },
        finalize: { nodeType: "compute" },
      },
      edges: [
        {
          from: "judge_solution",
          switch: {
            on: "route",
            cases: {
              classify: "bug_or_feature",
              human: "comment_and_escalate_to_human",
            },
          },
        },
        { from: "bug_or_feature", to: "check_initial_conflicts" },
        { from: "check_initial_conflicts", to: "judge_initial_conflicts" },
        { from: "judge_initial_conflicts", to: "comment_and_escalate_to_human" },
        { from: "comment_and_escalate_to_human", to: "post_escalation_comment" },
        { from: "post_escalation_comment", to: "finalize" },
      ],
    },
  });

  const layout = await buildGraphLayout(bundle.flow);

  assert.ok(layout);
  assert.ok(layout.nodePositions.finalize);
  assert.ok(layout.nodePositions.comment_and_escalate_to_human);
  assert.ok(layout.edgeRoutes["judge_solution->bug_or_feature-0-0"]?.points.length! >= 2);
  assert.ok(layout.nodePositions.finalize.y > layout.nodePositions.comment_and_escalate_to_human.y);
});

test("selectAttemptView falls back to hidden payloads for unknown structured messages", () => {
  const step = baseStep("check_ci", "action", "ok");
  const bundle = makeBundle(step, {
    sessions: {
      "main-bundle": {
        id: "main-bundle",
        binding: step.session!,
        record: {
          cwd: "/tmp/replay",
          agentCommand: "codex",
          name: "main",
          messages: [{ System: { content: "opaque" } }],
        },
        events: [],
      },
    },
  });

  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);
  assert.equal(selected.sessionSlice[0]?.role, "unknown");
  assert.equal(selected.sessionSlice[0]?.hiddenPayloads.length, 1);
  assert.equal(selected.sessionSlice[0]?.hiddenPayloads[0]?.label, "Raw message");
});

test("selectAttemptView summarizes encoded tool inputs and hidden tool results without text output", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(step, {
    sessions: {
      "main-bundle": {
        id: "main-bundle",
        binding: step.session!,
        record: {
          cwd: "/tmp/replay",
          agentCommand: "codex",
          name: "main",
          messages: [
            {
              Agent: {
                content: [
                  {
                    ToolUse: {
                      id: "tool-encoded",
                      name: "Run rg",
                      raw_input: JSON.stringify({
                        command: ["/bin/zsh", "-lc", "rg -n intent src"],
                      }),
                    },
                  },
                ],
                tool_results: {
                  "tool-encoded": {
                    tool_name: "Run rg",
                    is_error: false,
                    output: {
                      status: "completed",
                    },
                  },
                },
              },
            },
          ],
        },
        events: [],
      },
    },
  });

  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);
  assert.match(selected.sessionSlice[0]?.toolUses[0]?.summary ?? "", /rg -n intent src/);
  assert.equal(
    selected.sessionSlice[0]?.toolResults[0]?.preview,
    "Structured result hidden by default",
  );
});

test("selectAttemptView falls back to the latest visible ACP session for non-ACP steps", () => {
  const acpStep = baseStep("review_loop", "acp", "ok");
  const computeStep = baseStep("finalize", "compute", "ok");
  computeStep.session = null;
  computeStep.trace = undefined;

  const bundle = makeBundle(computeStep, {
    steps: [acpStep, computeStep],
  });

  const selected = selectAttemptView(bundle, 1);

  assert.ok(selected);
  assert.equal(selected.step.nodeId, "finalize");
  assert.equal(selected.sessionFromFallback, true);
  assert.equal(selected.sessionSourceStep?.nodeId, "review_loop");
  assert.equal(selected.sessionSlice.length, 2);
  assert.match(selected.sessionSlice[0]?.textBlocks[0] ?? "", /Please inspect the PR diff/);
});

test("revealConversationSlice progressively reveals tool calls before the full assistant turn completes", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(step, {});
  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);

  const partial = revealConversationSlice(selected.sessionSlice, 0.8);

  assert.equal(partial.length, 2);
  assert.equal(partial[0]?.textBlocks[0], "Please inspect the PR diff.");
  assert.match(partial[1]?.textBlocks[0] ?? "", /^I am checking/);
  assert.equal(partial[1]?.toolUses.length, 1);

  const full = revealConversationSlice(selected.sessionSlice, 1);
  assert.equal(full.length, selected.sessionSlice.length);
  assert.equal(full[1]?.toolUses.length, 1);
});

test("revealConversationTranscript keeps prior session messages visible while streaming the current slice", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(step, {
    sessions: {
      "main-bundle": {
        id: "main-bundle",
        binding: step.session!,
        record: {
          cwd: "/tmp/replay",
          agentCommand: "codex",
          name: "main",
          messages: [
            { User: { content: [{ Text: "Earlier context." }] } },
            { Agent: { content: [{ Text: "Older reply." }] } },
            { User: { content: [{ Text: "Current prompt." }] } },
            { Agent: { content: [{ Text: "Current streamed answer." }] } },
          ],
        },
        events: [],
      },
    },
  });
  bundle.steps[0]!.trace!.conversation = {
    sessionId: "main-bundle",
    messageStart: 2,
    messageEnd: 3,
    eventStartSeq: 0,
    eventEndSeq: 0,
  };

  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);

  const partial = revealConversationTranscript(selected.sessionSlice, 0.25);

  assert.equal(partial.length, 4);
  assert.equal(partial[0]?.textBlocks[0], "Earlier context.");
  assert.equal(partial[1]?.textBlocks[0], "Older reply.");
  assert.equal(partial[2]?.textBlocks[0], "Current prompt.");
  assert.match(partial[3]?.textBlocks[0] ?? "", /^Cur/);
});

test("listSessionViews returns all run sessions and marks the current streaming source", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const secondaryBinding = {
    ...step.session!,
    key: "secondary:/tmp",
    handle: "secondary",
    bundleId: "secondary-bundle",
    name: "secondary",
    acpxRecordId: "record-2",
    acpSessionId: "session-2",
  };
  const bundle = makeBundle(step, {
    sessions: {
      "main-bundle": {
        id: "main-bundle",
        binding: step.session!,
        record: {
          cwd: "/tmp/replay",
          agentCommand: "codex",
          name: "main",
          messages: [{ User: { content: [{ Text: "Main session." }] } }],
        },
        events: [],
      },
      "secondary-bundle": {
        id: "secondary-bundle",
        binding: secondaryBinding,
        record: {
          cwd: "/tmp/replay-secondary",
          agentCommand: "codex",
          name: "secondary",
          messages: [{ User: { content: [{ Text: "Secondary session." }] } }],
        },
        events: [],
      },
    },
  });

  const selected = selectAttemptView(bundle, 0);
  const sessions = listSessionViews(bundle, selected);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.label, "main");
  assert.equal(sessions[0]?.isStreamingSource, true);
  assert.equal(sessions[1]?.label, "secondary");
  assert.equal(sessions[1]?.isStreamingSource, false);
  assert.equal(sessions[1]?.sessionSlice[0]?.highlighted, false);
});

test("listSessionViews stays empty when the selected step has no ACP session source", () => {
  const first = baseStep("load_pr", "action", "ok");
  delete first.trace;
  const second = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(second, { steps: [first, second] });

  const selected = selectAttemptView(bundle, 0);
  const sessions = listSessionViews(bundle, selected);

  assert.ok(selected);
  assert.equal(selected.sessionRecord, null);
  assert.equal(sessions.length, 0);
});

test("buildPlaybackTimeline and anchors support continuous preview with discrete snapping", () => {
  const first = baseStep("load_pr", "action", "ok");
  first.startedAt = "2026-03-27T07:26:00.000Z";
  first.finishedAt = "2026-03-27T07:26:01.000Z";
  const second = baseStep("extract_intent", "acp", "ok");
  second.startedAt = "2026-03-27T07:26:02.000Z";
  second.finishedAt = "2026-03-27T07:26:20.000Z";

  const bundle = makeBundle(second, { steps: [first, second] });
  const timeline = buildPlaybackTimeline(bundle);

  assert.equal(timeline.segments.length, 2);
  assert.equal(playbackAnchorMs(timeline, 0), 0);
  assert.equal(playbackAnchorMs(timeline, 1), timeline.segments[1]?.startMs);

  const preview = derivePlaybackPreview(timeline, timeline.segments[1]!.startMs + 120);

  assert.equal(preview?.activeStepIndex, 1);
  assert.equal(preview?.nearestStepIndex, 1);
  assert.ok((preview?.stepProgress ?? 0) > 0);
});

test("resolvePlaybackResumeMs wraps terminal selections back to the start", () => {
  const first = baseStep("load_pr", "action", "ok");
  const second = baseStep("finalize", "compute", "ok");
  const bundle = makeBundle(second, { steps: [first, second] });
  const timeline = buildPlaybackTimeline(bundle);

  assert.equal(resolvePlaybackResumeMs(timeline, null, 1, bundle.steps.length), 0);
  assert.equal(
    resolvePlaybackResumeMs(timeline, null, 0, bundle.steps.length),
    playbackAnchorMs(timeline, 0),
  );
  assert.equal(resolvePlaybackResumeMs(timeline, 123, 1, bundle.steps.length), 123);
});

test("playbackSelectionMs clamps the final discrete step to the true timeline end", () => {
  const first = baseStep("load_pr", "action", "ok");
  const second = baseStep("finalize", "compute", "ok");
  const bundle = makeBundle(second, { steps: [first, second] });
  const timeline = buildPlaybackTimeline(bundle);

  assert.equal(playbackSelectionMs(timeline, 0, bundle.steps.length), 0);
  assert.equal(playbackSelectionMs(timeline, 1, bundle.steps.length), timeline.totalDurationMs);
});

test("advancePlaybackPlayhead applies playback speed and clamps to the timeline end", () => {
  assert.equal(advancePlaybackPlayhead(100, 400, 2, 1_000), 900);
  assert.equal(advancePlaybackPlayhead(100, 400, 5, 3_000), 2_100);
  assert.equal(advancePlaybackPlayhead(900, 400, 10, 1_000), 1_000);
});

test("resolveSelectedStepIndexAfterBundleUpdate follows the live edge when new steps append", () => {
  const first = baseStep("load_pr", "action", "ok");
  const second = baseStep("extract_intent", "acp", "ok");
  const third = baseStep("judge_solution", "acp", "ok");
  const previousBundle = makeBundle(second, { steps: [first, second] });
  const nextBundle = makeBundle(third, { steps: [first, second, third] });

  assert.equal(resolveSelectedStepIndexAfterBundleUpdate(previousBundle, nextBundle, 1, null), 2);
});

test("resolveSelectedStepIndexAfterBundleUpdate preserves rewind position while a run grows", () => {
  const first = baseStep("load_pr", "action", "ok");
  const second = baseStep("extract_intent", "acp", "ok");
  const third = baseStep("judge_solution", "acp", "ok");
  const previousBundle = makeBundle(second, { steps: [first, second] });
  const nextBundle = makeBundle(third, { steps: [first, second, third] });

  assert.equal(resolveSelectedStepIndexAfterBundleUpdate(previousBundle, nextBundle, 0, null), 0);
  assert.equal(
    resolveSelectedStepIndexAfterBundleUpdate(previousBundle, nextBundle, 1, "playing"),
    1,
  );
});

test("format helpers keep replay labels stable", () => {
  assert.equal(formatDuration(undefined), "n/a");
  assert.equal(formatDuration(500), "500 ms");
  assert.equal(formatDuration(1_500), "1.5 s");
  assert.equal(formatJson({ ok: true }), '{\n  "ok": true\n}');
  assert.equal(humanizeIdentifier("collect_review_state"), "Collect Review State");
});

test("deriveRunOutcomeView separates replay position from a failed run outcome", () => {
  const review = baseStep("review_loop", "acp", "failed");
  const bundle = makeBundle(review, {});
  bundle.run.status = "failed";
  bundle.run.currentNode = "review_loop";
  bundle.run.currentAttemptId = "review_loop#1";
  bundle.run.error = "Timed out while waiting for review_loop JSON output.";

  const outcome = deriveRunOutcomeView(bundle);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.accent, "failed");
  assert.equal(outcome.isTerminal, true);
  assert.equal(outcome.nodeId, "review_loop");
  assert.match(outcome.headline, /Stopped at Review Loop/);
  assert.match(outcome.detail, /Timed out while waiting/);
});

test("deriveRunOutcomeView reports completed runs independently of replay position", () => {
  const finalize = baseStep("finalize", "compute", "ok");
  const bundle = makeBundle(finalize, {});

  const outcome = deriveRunOutcomeView(bundle);

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.accent, "ok");
  assert.equal(outcome.isTerminal, true);
  assert.match(outcome.headline, /Run completed/);
});

function makeBundle(
  step: FlowStepRecord,
  overrides: Partial<LoadedRunBundle> & {
    steps?: FlowStepRecord[];
  },
): LoadedRunBundle {
  const steps = overrides.steps ?? [step];
  const manifest: FlowRunManifest = {
    schema: "acpx.flow-run-bundle.v1",
    runId: "run-1",
    flowName: overrides.flow?.name ?? "pr-triage",
    startedAt: "2026-03-27T07:26:00.000Z",
    status: "completed",
    traceSchema: "acpx.flow-trace-event.v1",
    paths: {
      flow: "flow.json",
      trace: "trace.ndjson",
      runProjection: "projections/run.json",
      liveProjection: "projections/live.json",
      stepsProjection: "projections/steps.json",
      sessionsDir: "sessions",
      artifactsDir: "artifacts",
    },
    sessions: [
      {
        id: "main-bundle",
        handle: "main",
        bindingPath: "sessions/main/binding.json",
        recordPath: "sessions/main/record.json",
        eventsPath: "sessions/main/events.ndjson",
      },
    ],
  };

  const run: FlowRunState = {
    runId: "run-1",
    flowName: overrides.flow?.name ?? "pr-triage",
    startedAt: "2026-03-27T07:26:00.000Z",
    updatedAt: "2026-03-27T07:27:13.000Z",
    status: "completed",
    input: {},
    outputs: {},
    results: {},
    steps,
    sessionBindings: {
      main: step.session!,
    },
  };

  return {
    sourceType: "sample",
    sourceLabel: "sample",
    manifest,
    flow: overrides.flow ?? {
      schema: "acpx.flow-definition-snapshot.v1",
      name: "pr-triage",
      startAt: "extract_intent",
      nodes: {
        extract_intent: {
          nodeType: "acp",
          hasPrompt: true,
          session: { handle: "main", isolated: false },
          cwd: { mode: "default" },
        },
      },
      edges: [],
    },
    run,
    live: overrides.live ?? null,
    steps,
    trace: overrides.trace ?? [
      {
        seq: 1,
        at: "2026-03-27T07:27:13.000Z",
        scope: "node",
        type: "node_completed",
        runId: "run-1",
        nodeId: step.nodeId,
        attemptId: step.attemptId,
        payload: { outcome: step.outcome },
      },
    ],
    sessions: overrides.sessions ?? {
      "main-bundle": {
        id: "main-bundle",
        binding: step.session!,
        record: {
          cwd: "/tmp/replay",
          agentCommand: "codex",
          name: "main",
          messages: [
            {
              User: {
                id: "u1",
                content: [{ Text: "Please inspect the PR diff." }],
              },
            },
            {
              Agent: {
                content: [
                  { Text: "I am checking the runtime changes now." },
                  {
                    ToolUse: {
                      id: "tool-1",
                      name: "Read pr.json",
                      input: {
                        parsed_cmd: [
                          {
                            name: "Read pr.json",
                            cmd: "sed -n '1,200p' .acpx-flow/pr.json",
                          },
                        ],
                      },
                    },
                  },
                ],
                tool_results: {
                  "tool-1": {
                    tool_name: "Read pr.json",
                    is_error: false,
                    output: {
                      status: "completed",
                      formatted_output: 'stdout: {"number": 181}',
                    },
                  },
                },
              },
            },
          ],
        },
        events: [
          {
            seq: 2,
            at: "2026-03-27T07:26:08.000Z",
            direction: "outbound",
            message: {
              method: "session/prompt",
            },
          },
          {
            seq: 3,
            at: "2026-03-27T07:27:13.000Z",
            direction: "inbound",
            message: {
              result: "ok",
            },
          },
        ],
      },
    },
  };
}

function baseStep(
  nodeId: string,
  nodeType: FlowStepRecord["nodeType"],
  outcome: FlowStepRecord["outcome"],
): FlowStepRecord {
  return {
    attemptId: `${nodeId}#1`,
    nodeId,
    nodeType,
    outcome,
    startedAt: "2026-03-27T07:26:08.000Z",
    finishedAt: "2026-03-27T07:27:13.000Z",
    promptText: "prompt",
    rawText: "response",
    output: { ok: true },
    session: {
      key: "main:/tmp",
      handle: "main",
      bundleId: "main-bundle",
      name: "main",
      agentName: "codex",
      agentCommand: "codex",
      cwd: "/tmp/replay",
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
    },
    agent: {
      agentName: "codex",
      agentCommand: "codex",
      cwd: "/tmp/replay",
    },
    trace: {
      sessionId: "main-bundle",
      conversation: {
        sessionId: "main-bundle",
        messageStart: 0,
        messageEnd: 1,
        eventStartSeq: 2,
        eventEndSeq: 3,
      },
    },
  };
}
