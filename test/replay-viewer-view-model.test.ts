import assert from "node:assert/strict";
import test from "node:test";
import type { Dimensions } from "@xyflow/react";
import {
  advancePlaybackPlayhead,
  resolvePlaybackResumeMs,
  resolveSelectedStepIndexAfterBundleUpdate,
} from "../examples/flows/replay-viewer/src/hooks/use-playback-controller.js";
import { projectRunBundle } from "../examples/flows/replay-viewer/src/lib/run-projection.js";
import { resolveSessionRenderState } from "../examples/flows/replay-viewer/src/lib/session-render-state.js";
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
  FlowDefinitionSnapshot,
  FlowRunManifest,
  FlowRunState,
  FlowStepRecord,
  LoadedRunBundle,
} from "../examples/flows/replay-viewer/src/types.js";
import { validateFlowDefinition } from "../src/flows/graph.js";

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
  assert.ok(graph.edges.every((edge) => edge.sourceHandle === "out-bottom"));
  assert.ok(graph.edges.every((edge) => edge.targetHandle === "in-top"));
});

for (const fixture of [
  {
    name: "an unreachable two-node cycle",
    nodeIds: ["a", "b"],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  },
  {
    name: "an unreachable self-loop",
    nodeIds: ["a"],
    edges: [{ from: "a", to: "a" }],
  },
  {
    name: "an unreachable chain entering a cycle",
    nodeIds: ["a", "b", "c"],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "b" },
    ],
  },
  {
    name: "multiple unreachable cyclic components",
    nodeIds: ["a", "b", "c"],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "c", to: "c" },
    ],
  },
]) {
  for (const layoutMode of ["fallback", "elk"] as const) {
    test(`buildGraph projects ${fixture.name} with ${layoutMode} layout`, async () => {
      const nodeIds = ["s", ...fixture.nodeIds];
      const flow: FlowDefinitionSnapshot = {
        schema: "acpx.flow-definition-snapshot.v1",
        name: "unused-cycle-flow",
        startAt: "s",
        nodes: Object.fromEntries(
          nodeIds.map((nodeId) => [nodeId, { nodeType: "compute" as const }]),
        ),
        edges: fixture.edges,
      };
      validateFlowDefinition({
        name: flow.name,
        startAt: flow.startAt,
        nodes: Object.fromEntries(
          nodeIds.map((nodeId) => [nodeId, { nodeType: "compute" as const, run: () => ({}) }]),
        ),
        edges: flow.edges,
      });
      const bundle = makeBundle(baseStep("s", "compute", "ok"), { flow, sessions: {} });
      const layout =
        layoutMode === "elk" ? await buildGraphLayout(flow, graphMeasurements(flow)) : null;
      if (layoutMode === "elk") {
        assert.ok(layout, "the real layout engine must succeed before testing its projection");
      }

      const graph = buildGraph(bundle, 0, null, layout);

      assert.deepEqual(graph.nodes.map((node) => node.id).toSorted(), nodeIds.toSorted());
      assert.deepEqual(
        graph.edges.map((edge) => [edge.source, edge.target]),
        fixture.edges.map((edge) => [edge.from, edge.to]),
      );
      for (const node of graph.nodes) {
        assert.ok(Number.isFinite(node.position.x));
        assert.ok(Number.isFinite(node.position.y));
        assert.equal(node.data.status, node.id === "s" ? "completed" : "queued");
        assert.equal(node.data.attempts, node.id === "s" ? 1 : 0);
        assert.equal(node.data.isTerminal, node.id === "s");
        if (layout) {
          assert.deepEqual(node.position, layout.nodePositions[node.id]);
        }
      }
    });
  }
}

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
  const preview = derivePlaybackPreview(timeline, timeline.segments[1].startMs + 200);
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

  const layout = await buildGraphLayout(bundle.flow, graphMeasurements(bundle.flow));

  assert.ok(layout);
  assert.ok(layout.nodePositions.finalize);
  assert.ok(layout.nodePositions.comment_and_escalate_to_human);
  assert.ok(layout.edgeRoutes["judge_solution->bug_or_feature-0-0"]?.points.length >= 2);
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
  bundle.steps[0].trace!.conversation = {
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

  const preview = derivePlaybackPreview(timeline, timeline.segments[1].startMs + 120);

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

function graphMeasurements(flow: FlowDefinitionSnapshot): ReadonlyMap<string, Dimensions> {
  return new Map(
    Object.keys(flow.nodes).map((nodeId, index) => [
      nodeId,
      { width: 264, height: 130 + index * 7 },
    ]),
  );
}

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

const fallbackReply =
  "CURRENT-ANSWER-START. This answer was already completed before the next step. CURRENT-ANSWER-END.";

function makeFallbackRevealBundle(nodeType: "compute" | "action" | "checkpoint"): LoadedRunBundle {
  const acp = baseStep("extract_intent", "acp", "ok");
  acp.trace!.conversation!.messageStart = 2;
  acp.trace!.conversation!.messageEnd = 3;
  const following = baseStep(`following_${nodeType}`, nodeType, "ok");
  following.session = null;
  following.agent = null;
  following.trace = undefined;
  // Pass the ACP step to makeBundle so its session binding remains real fixture data.
  const bundle = makeBundle(acp, { steps: [acp, following] });
  bundle.sessions["main-bundle"].record.messages = [
    { User: { id: "prefix-user", content: [{ Text: "Earlier synthetic context." }] } },
    { Agent: { content: [{ Text: "PREFIX-CONTEXT-READY" }], tool_results: {} } },
    { User: { id: "current-user", content: [{ Text: "Provide the current synthetic answer." }] } },
    { Agent: { content: [{ Text: fallbackReply }], tool_results: {} } },
  ];
  return bundle;
}

for (const nodeType of ["compute", "action", "checkpoint"] as const) {
  test(`a ${nodeType} fallback retains completed ACP context throughout replay`, () => {
    const bundle = makeFallbackRevealBundle(nodeType);
    const selected = selectAttemptView(bundle, 1);
    assert.ok(selected);
    assert.equal(selected.sessionFromFallback, true);
    assert.equal(selected.sessionSourceStep?.attemptId, bundle.steps[0]?.attemptId);
    const item = listSessionViews(bundle, selected).find((entry) => entry.id === "main-bundle");
    assert.ok(item);
    // Setting the source session ID to null would silently lose this range.
    assert.deepEqual(
      item.sessionSlice.map((message) => message.highlighted),
      [false, false, true, true],
    );
    assert.deepEqual(item.sessionSlice, selected.sessionSlice);
    for (const progress of [0, 0.25, 0.8, 1]) {
      const rendered = resolveSessionRenderState({
        sessionSlice: item.sessionSlice,
        isStreamingSource: item.isStreamingSource,
        sessionRevealProgress: progress,
        liveStreaming: false,
      });
      assert.equal(
        rendered.renderedSessionSlice.at(-1)?.textBlocks[0],
        fallbackReply,
        `completed reply shortened at progress ${progress}`,
      );
      assert.deepEqual(rendered.renderedSessionSlice, item.sessionSlice);
      assert.equal(rendered.animateConversation, false);
      assert.equal(rendered.autoFollowConversation, false);
    }
    assert.equal(item.isStreamingSource, false);
  });
}

test("the direct ACP attempt still reveals its own range and preserves earlier context", () => {
  const bundle = makeFallbackRevealBundle("compute");
  const selected = selectAttemptView(bundle, 0);
  assert.ok(selected);
  assert.equal(selected.sessionFromFallback, false);
  const item = listSessionViews(bundle, selected).find((entry) => entry.id === "main-bundle");
  assert.ok(item);
  assert.equal(item.isStreamingSource, true);
  assert.deepEqual(
    item.sessionSlice.map((message) => message.highlighted),
    [false, false, true, true],
  );
  const partial = resolveSessionRenderState({
    sessionSlice: item.sessionSlice,
    isStreamingSource: item.isStreamingSource,
    sessionRevealProgress: 0.25,
    liveStreaming: false,
  });
  assert.equal(partial.renderedSessionSlice[1]?.textBlocks[0], "PREFIX-CONTEXT-READY");
  const currentText = partial.renderedSessionSlice.at(-1)?.textBlocks[0] ?? "";
  assert(currentText.length > 0 && currentText.length < fallbackReply.length);
  assert(fallbackReply.startsWith(currentText));
  assert.equal(partial.animateConversation, true);
  assert.equal(partial.autoFollowConversation, true);
  for (const [progress, liveStreaming] of [
    [1, false],
    [0.25, true],
  ] as const) {
    const rendered = resolveSessionRenderState({
      sessionSlice: item.sessionSlice,
      isStreamingSource: item.isStreamingSource,
      sessionRevealProgress: progress,
      liveStreaming,
    });
    assert.deepEqual(rendered.renderedSessionSlice, item.sessionSlice);
    assert.equal(rendered.autoFollowConversation, true);
    assert.equal(rendered.animateConversation, !liveStreaming);
  }
});

test("an unrelated session remains fully visible without becoming the reveal source", () => {
  const bundle = makeFallbackRevealBundle("compute");
  const main = bundle.sessions["main-bundle"];
  bundle.sessions.other = {
    ...main,
    id: "other",
    binding: { ...main.binding, bundleId: "other", name: "other" },
    record: {
      ...main.record,
      name: "other",
      messages: [{ Agent: { content: [{ Text: "UNRELATED-COMPLETE-ANSWER" }], tool_results: {} } }],
    },
  };
  const selected = selectAttemptView(bundle, 0);
  assert.ok(selected);
  const other = listSessionViews(bundle, selected).find((entry) => entry.id === "other");
  assert.ok(other);
  assert.equal(other.isStreamingSource, false);
  assert.deepEqual(
    other.sessionSlice.map((message) => message.highlighted),
    [false],
  );
  const rendered = resolveSessionRenderState({
    sessionSlice: other.sessionSlice,
    isStreamingSource: other.isStreamingSource,
    sessionRevealProgress: 0.25,
    liveStreaming: false,
  });
  assert.deepEqual(rendered.renderedSessionSlice, other.sessionSlice);
  assert.equal(rendered.animateConversation, false);
});

test("later persistent-session output does not retime an earlier completed attempt", () => {
  const first = attemptDurationStep("first", 0, 1);
  const second = attemptDurationStep("second", 2, 3);
  const bundle = attemptDurationBundle(
    [first, second],
    [
      { User: { content: [{ Text: "First prompt" }] } },
      { Agent: { content: [{ Text: "FIRST-REPLY" }], tool_results: {} } },
      { User: { content: [{ Text: "Second prompt" }] } },
      { Agent: { content: [{ Text: "x" }], tool_results: {} } },
    ],
  );
  const before = buildPlaybackTimeline(bundle);
  assert.deepEqual(
    before.segments.map((segment) => segment.durationMs),
    [700, 700],
  );
  assert.equal(derivePlaybackPreview(before, 1_000)?.activeStepIndex, 1);

  const grown = structuredClone(bundle);
  grown.sessions["main-bundle"].record.messages![3] = {
    Agent: { content: [{ Text: "x".repeat(1_000) }], tool_results: {} },
  };
  const after = buildPlaybackTimeline(grown);
  assert.deepEqual(
    after.segments.map((segment) => segment.durationMs),
    [700, 3_420],
  );
  assert.deepEqual(after.segments[0], before.segments[0]);
  assert.equal(playbackAnchorMs(after, 1), playbackAnchorMs(before, 1));
  assert.equal(derivePlaybackPreview(after, 1_000)?.activeStepIndex, 1);
  const selected = selectAttemptView(grown, 0);
  assert.ok(selected);
  assert.equal(selected.sessionSlice.length, 4);
  assert.equal(selected.sessionSlice[3]?.textBlocks[0], "x".repeat(1_000));
});

for (const fixture of [
  {
    name: "includes a single agent message at the zero start and end index",
    start: 0,
    end: 0,
    messages: [
      { Agent: { content: [{ Text: "a".repeat(100) }], tool_results: {} } },
      { Agent: { content: [{ Text: "later".repeat(200) }], tool_results: {} } },
    ],
    expected: 720,
  },
  {
    name: "excludes prior and later context and does not weight the selected user prompt",
    start: 2,
    end: 3,
    messages: [
      { User: { content: [{ Text: "Earlier prompt" }] } },
      { Agent: { content: [{ Text: "before".repeat(200) }], tool_results: {} } },
      { User: { content: [{ Text: "prompt".repeat(1_000) }] } },
      { Agent: { content: [{ Text: "a".repeat(100) }], tool_results: {} } },
      { Agent: { content: [{ Text: "later".repeat(200) }], tool_results: {} } },
    ],
    expected: 720,
  },
  {
    name: "does not weight context for an empty recorded range",
    start: 1,
    end: 0,
    messages: [{ Agent: { content: [{ Text: "x".repeat(1_000) }], tool_results: {} } }],
    expected: 700,
  },
  {
    name: "does not weight context when the recorded range has no available messages",
    start: 9,
    end: 9,
    messages: [{ Agent: { content: [{ Text: "x".repeat(1_000) }], tool_results: {} } }],
    expected: 700,
  },
]) {
  test(`attempt replay duration ${fixture.name}`, () => {
    const step = attemptDurationStep("selected", fixture.start, fixture.end);
    const bundle = attemptDurationBundle([step], fixture.messages);
    assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, fixture.expected);
    assert.equal(selectAttemptView(bundle, 0)?.sessionSlice.length, fixture.messages.length);
  });
}

test("a direct session without a recorded range has no progressive-reveal duration", () => {
  const step = attemptDurationStep("unranged", 0, 0);
  step.trace = { sessionId: "main-bundle" };
  const bundle = attemptDurationBundle(
    [step],
    [{ Agent: { content: [{ Text: "x".repeat(1_000) }], tool_results: {} } }],
  );
  const selected = selectAttemptView(bundle, 0);
  assert.ok(selected);
  assert.equal(selected.sessionFromFallback, false);
  assert.equal(selected.sessionSlice[0]?.highlighted, false);
  assert.deepEqual(
    revealConversationTranscript(selected.sessionSlice, 0.25),
    selected.sessionSlice,
  );
  assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, 700);
});

test("a missing session record retains the normal minimum replay duration", () => {
  const step = attemptDurationStep("missing", 0, 1);
  const bundle = makeBundle(step, { sessions: {} });
  assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, 700);
});

test("an ACP attempt using earlier session context retains its own text duration", () => {
  const first = attemptDurationStep("first", 0, 1);
  const fallback = attemptDurationStep("fallback", 0, 1);
  fallback.trace = undefined;
  fallback.session = null;
  fallback.promptText = "p".repeat(100);
  fallback.rawText = "r".repeat(100);
  const bundle = attemptDurationBundle(
    [first, fallback],
    [
      { User: { content: [{ Text: "First prompt" }] } },
      { Agent: { content: [{ Text: "context".repeat(1_000) }], tool_results: {} } },
    ],
  );
  assert.equal(selectAttemptView(bundle, 1)?.sessionFromFallback, true);
  assert.equal(buildPlaybackTimeline(bundle).segments[1]?.durationMs, 1_020);
});

test("attempt-scoped replay weighting retains elapsed-time floors and duration caps", () => {
  for (const [elapsedMs, answer, expected] of [
    [16_000, "short", 2_000],
    [40_000, "short", 3_800],
    [0, "x".repeat(2_000), 3_800],
  ] as const) {
    const step = attemptDurationStep("timing", 0, 1);
    step.finishedAt = new Date(Date.parse(step.startedAt) + elapsedMs).toISOString();
    const bundle = attemptDurationBundle(
      [step],
      [
        { User: { content: [{ Text: "prompt" }] } },
        { Agent: { content: [{ Text: answer }], tool_results: {} } },
      ],
    );
    assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, expected);
  }
});

test("live ACP range growth changes only the current attempt's replay duration", () => {
  const completed = attemptDurationStep("completed", 0, 1);
  assert.ok(completed.session);
  assert.ok(completed.trace?.conversation);
  const acpSessionId = completed.session.acpSessionId;
  completed.trace.conversation.eventStartSeq = 1;
  completed.trace.conversation.eventEndSeq = 3;
  const bundle = attemptDurationBundle(
    [completed],
    [
      { User: { id: "earlier-user", content: [{ Text: "Earlier prompt" }] } },
      { Agent: { content: [{ Text: "FIRST-REPLY" }], tool_results: {} } },
    ],
  );
  const timestamp = completed.startedAt;
  Object.assign(bundle.run, {
    status: "running",
    currentNode: "streaming",
    currentAttemptId: "streaming#1",
    currentNodeType: "acp",
    currentNodeStartedAt: timestamp,
    updatedAt: timestamp,
  });
  bundle.live = { ...bundle.run };
  bundle.sessions["main-bundle"].record.lastSeq = 3;
  bundle.trace = [
    {
      seq: 1,
      at: timestamp,
      scope: "acp",
      type: "acp_prompt_prepared",
      runId: bundle.run.runId,
      nodeId: "streaming",
      attemptId: "streaming#1",
      sessionId: "main-bundle",
      payload: { sessionId: "main-bundle" },
    },
  ];
  const events = [
    {
      seq: 4,
      at: timestamp,
      direction: "outbound" as const,
      message: {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { sessionId: acpSessionId, prompt: [{ type: "text", text: "Current prompt" }] },
      },
    },
    ...[5, 6].map((seq) => ({
      seq,
      at: timestamp,
      direction: "inbound" as const,
      message: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: acpSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(100) },
          },
        },
      },
    })),
  ];
  for (const [eventCount, currentDuration, messageEnd] of [
    [1, 700, 2],
    [2, 720, 3],
    [3, 1_020, 3],
  ] as const) {
    bundle.sessions["main-bundle"].events = events.slice(0, eventCount);
    const state = projectRunBundle({ ...bundle, schema: "acpx.viewer-run-live.v1" });
    assert.equal(state.steps[1]?.trace?.conversation?.messageStart, 2);
    assert.equal(state.steps[1]?.trace?.conversation?.messageEnd, messageEnd);
    const timeline = buildPlaybackTimeline(state);
    assert.deepEqual(
      timeline.segments.map((segment) => segment.durationMs),
      [700, currentDuration],
    );
    assert.equal(playbackAnchorMs(timeline, 1), 700);
    assert.equal(derivePlaybackPreview(timeline, 1_000)?.activeStepIndex, 1);
  }
  assert.equal(bundle.sessions["main-bundle"].record.messages?.length, 2);
});

test("a selected user-only range retains zero reveal weight without falling back to prompt text", () => {
  const step = attemptDurationStep("user_only", 0, 0);
  const prompt = "q".repeat(2_000);
  step.promptText = prompt;
  const bundle = attemptDurationBundle(
    [step],
    [{ User: { id: "user-only", content: [{ Text: prompt }] } }],
  );
  assert.equal(selectAttemptView(bundle, 0)?.sessionSlice[0]?.role, "user");
  assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, 700);
});

test("selected mixed content retains tool weights alongside text", () => {
  const step = attemptDurationStep("mixed", 0, 1);
  const input = { command: ["echo", "ok"] };
  const bundle = attemptDurationBundle(
    [step],
    [
      { User: { id: "mixed-user", content: [{ Text: "q".repeat(1_000) }] } },
      {
        Agent: {
          content: [
            { Text: "a".repeat(80) },
            {
              ToolUse: {
                id: "mixed-tool",
                name: "Echo",
                raw_input: JSON.stringify(input),
                input,
                is_input_complete: true,
              },
            },
          ],
          tool_results: {
            "mixed-tool": {
              tool_use_id: "mixed-tool",
              tool_name: "Echo",
              is_error: false,
              content: { Text: "done" },
            },
          },
        },
      },
    ],
  );
  const selected = selectAttemptView(bundle, 0);
  assert.ok(selected);
  assert.equal(selected.sessionSlice[1]?.toolUses[0]?.summary, "echo ok");
  assert.equal(selected.sessionSlice[1]?.toolResults[0]?.preview, "done");
  // User text has zero weight; 80 text characters plus two 16-character tool floors.
  assert.equal(buildPlaybackTimeline(bundle).segments[0]?.durationMs, 756);
});

function attemptDurationStep(nodeId: string, start: number, end: number): FlowStepRecord {
  const step = baseStep(nodeId, "acp", "ok");
  step.finishedAt = step.startedAt;
  step.promptText = null;
  step.rawText = null;
  assert.ok(step.trace?.conversation);
  step.trace.conversation.messageStart = start;
  step.trace.conversation.messageEnd = end;
  return step;
}

function attemptDurationBundle(steps: FlowStepRecord[], messages: unknown[]): LoadedRunBundle {
  const first = steps[0];
  assert.ok(first);
  const bundle = makeBundle(first, { steps });
  bundle.sessions["main-bundle"].record.messages = messages;
  return bundle;
}

type MergeEdgeGraph = ReturnType<typeof buildGraph>;
type MergeEdgeLayout = NonNullable<Awaited<ReturnType<typeof buildGraphLayout>>>;

function mergeEdgeFlow(
  name: string,
  nodeIds: string[],
  edges: FlowDefinitionSnapshot["edges"],
): FlowDefinitionSnapshot {
  const flow: FlowDefinitionSnapshot = {
    schema: "acpx.flow-definition-snapshot.v1",
    name,
    startAt: "s",
    nodes: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, { nodeType: "compute" as const }])),
    edges,
  };
  validateFlowDefinition({
    name: flow.name,
    startAt: flow.startAt,
    nodes: Object.fromEntries(
      nodeIds.map((nodeId) => [nodeId, { nodeType: "compute" as const, run: () => ({}) }]),
    ),
    edges,
  });
  return flow;
}

function mergeEdgeBundle(flow: FlowDefinitionSnapshot, recordedNodes = ["s"]): LoadedRunBundle {
  const steps: FlowStepRecord[] = recordedNodes.map((nodeId, index) => ({
    ...baseStep(nodeId, "compute", "ok"),
    attemptId: `${nodeId}#${index + 1}`,
    startedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, index * 2)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, index * 2 + 1)).toISOString(),
    promptText: null,
    rawText: null,
    session: null,
    agent: null,
    trace: undefined,
  }));
  const bundle = makeBundle(baseStep("s", "compute", "ok"), {
    flow,
    steps,
    sessions: {},
    trace: [],
  });
  bundle.manifest.sessions = [];
  bundle.run.sessionBindings = {};
  return bundle;
}

function mergeEdgeNode(graph: MergeEdgeGraph, nodeId: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `expected graph node ${nodeId}`);
  return node;
}

function mergeEdgeBetween(graph: MergeEdgeGraph, source: string, target: string) {
  const edges = graph.edges.filter((edge) => edge.source === source && edge.target === target);
  assert.equal(edges.length, 1, `expected exactly one ${source}->${target} edge`);
  const edge = edges[0];
  assert.ok(edge);
  return edge;
}

function assertMergeEdgeStyle(
  graph: MergeEdgeGraph,
  source: string,
  target: string,
  expectedBack: boolean,
) {
  const edge = mergeEdgeBetween(graph, source, target);
  assert.equal(edge.data?.isBackEdge, expectedBack, edge.id);
  assert.equal(edge.style?.strokeDasharray, expectedBack ? "6 5" : undefined, edge.id);
  assert.equal(edge.zIndex, expectedBack ? 0 : 1, edge.id);
}

function assertMergeEdgeGeometryAgreement(graph: MergeEdgeGraph, layout: MergeEdgeLayout | null) {
  for (const node of graph.nodes) {
    assert.ok(Number.isFinite(node.position.x), node.id);
    assert.ok(Number.isFinite(node.position.y), node.id);
    if (layout) {
      assert.deepEqual(node.position, layout.nodePositions[node.id]);
    }
  }
  for (const edge of graph.edges) {
    assert.equal(edge.sourceHandle, "out-bottom");
    assert.equal(edge.targetHandle, "in-top");
    const source = mergeEdgeNode(graph, edge.source);
    const target = mergeEdgeNode(graph, edge.target);
    const expectedBack = edge.source === edge.target || target.position.y < source.position.y;
    assertMergeEdgeStyle(graph, edge.source, edge.target, expectedBack);
    if (layout) {
      const route = layout.edgeRoutes[edge.id];
      assert.ok(route, `expected ELK route for ${edge.id}`);
      assert.ok(route.points.length >= 2, edge.id);
      assert.ok(
        route.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      );
      assert.equal(route.isBackEdge, expectedBack, `ELK metadata for ${edge.id}`);
      assert.deepEqual(edge.data?.points, route.points);
    }
  }
}

for (const fixture of [
  {
    name: "the original equal-distance forward merge",
    flow: mergeEdgeFlow(
      "equal-distance-merge",
      ["s", "a", "b", "end"],
      [
        { from: "s", switch: { on: "$.route", cases: { long: "a", short: "b" } } },
        { from: "a", to: "b" },
        { from: "b", to: "end" },
      ],
    ),
    source: "a",
    target: "b",
  },
  {
    name: "a forward merge whose shortest distance decreases",
    flow: mergeEdgeFlow(
      "decreasing-distance-merge",
      ["s", "a", "b", "c", "end"],
      [
        { from: "s", switch: { on: "$.route", cases: { long: "a", short: "c" } } },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "end" },
      ],
    ),
    source: "b",
    target: "c",
  },
]) {
  for (const layoutMode of ["fallback", "elk"] as const) {
    test(`buildGraph keeps ${fixture.name} downward and solid with ${layoutMode} layout`, async () => {
      const bundle = mergeEdgeBundle(fixture.flow);
      const layout =
        layoutMode === "elk"
          ? await buildGraphLayout(fixture.flow, graphMeasurements(fixture.flow))
          : null;
      if (layoutMode === "elk") {
        assert.ok(layout, "real ELK layout must succeed");
      }
      const graph = buildGraph(bundle, 0, null, layout);
      assert.equal(graph.nodes.length, Object.keys(fixture.flow.nodes).length);
      assert.ok(
        mergeEdgeNode(graph, fixture.target).position.y >
          mergeEdgeNode(graph, fixture.source).position.y,
        "the longer route must retain its forward rank constraint",
      );
      assertMergeEdgeStyle(graph, fixture.source, fixture.target, false);
      assert.ok(graph.edges.every((edge) => edge.data?.isBackEdge === false));
      assertMergeEdgeGeometryAgreement(graph, layout);
    });
  }
}

for (const fixture of [
  {
    name: "a reachable repeat loop",
    flow: mergeEdgeFlow(
      "repeat-loop",
      ["s", "a", "b", "end"],
      [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", switch: { on: "$.route", cases: { again: "a", done: "end" } } },
      ],
    ),
    edgeCount: 4,
  },
  {
    name: "a cycle at equal shortest distance",
    flow: mergeEdgeFlow(
      "equal-depth-cycle",
      ["s", "a", "b", "end"],
      [
        { from: "s", switch: { on: "$.route", cases: { long: "a", short: "b" } } },
        { from: "a", to: "b" },
        { from: "b", switch: { on: "$.route", cases: { again: "a", done: "end" } } },
      ],
    ),
    edgeCount: 5,
  },
]) {
  for (const layoutMode of ["fallback", "elk"] as const) {
    test(`buildGraph retains a real return in ${fixture.name} with ${layoutMode} layout`, async () => {
      const layout =
        layoutMode === "elk"
          ? await buildGraphLayout(fixture.flow, graphMeasurements(fixture.flow))
          : null;
      if (layoutMode === "elk") {
        assert.ok(layout, "real ELK layout must succeed");
      }
      const graph = buildGraph(mergeEdgeBundle(fixture.flow), 0, null, layout);
      assert.equal(graph.nodes.length, 4);
      assert.equal(graph.edges.length, fixture.edgeCount);
      const a = mergeEdgeNode(graph, "a");
      const b = mergeEdgeNode(graph, "b");
      assert.notEqual(a.position.y, b.position.y, "the reciprocal pair spans two ranks");
      const returnEdge: [string, string] = a.position.y > b.position.y ? ["a", "b"] : ["b", "a"];
      assertMergeEdgeStyle(graph, returnEdge[0], returnEdge[1], true);
      assertMergeEdgeStyle(graph, returnEdge[1], returnEdge[0], false);
      assert.ok(mergeEdgeNode(graph, "end").position.y >= Math.max(a.position.y, b.position.y));
      assertMergeEdgeGeometryAgreement(graph, layout);
    });
  }
}

for (const layoutMode of ["fallback", "elk"] as const) {
  test(`buildGraph retains unused cycle and self-loop direction with ${layoutMode} layout`, async () => {
    const flow = mergeEdgeFlow(
      "unused-loops",
      ["s", "a", "b", "self"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "self", to: "self" },
      ],
    );
    const layout =
      layoutMode === "elk" ? await buildGraphLayout(flow, graphMeasurements(flow)) : null;
    if (layoutMode === "elk") {
      assert.ok(layout, "real ELK layout must succeed");
    }
    const graph = buildGraph(mergeEdgeBundle(flow), 0, null, layout);
    assert.deepEqual(graph.nodes.map((node) => node.id).toSorted(), ["a", "b", "s", "self"]);
    assert.equal(graph.edges.length, 3);
    for (const node of graph.nodes) {
      assert.equal(node.data.status, node.id === "s" ? "completed" : "queued");
      assert.equal(node.data.attempts, node.id === "s" ? 1 : 0);
    }
    assert.notEqual(mergeEdgeNode(graph, "a").position.y, mergeEdgeNode(graph, "b").position.y);
    assertMergeEdgeStyle(graph, "self", "self", true);
    assertMergeEdgeGeometryAgreement(graph, layout);
  });
}

for (const fixture of [
  { name: "upward", targetY: -236, expectedBack: true },
  { name: "tied", targetY: 0, expectedBack: false },
  { name: "downward", targetY: 236, expectedBack: false },
]) {
  test(`buildGraph uses final ${fixture.name} geometry over conflicting route metadata`, () => {
    const flow = mergeEdgeFlow(
      "supplied-layout-direction",
      ["s", "end"],
      [{ from: "s", to: "end" }],
    );
    const layout: MergeEdgeLayout = {
      nodePositions: { s: { x: 0, y: 0 }, end: { x: 332, y: fixture.targetY } },
      edgeRoutes: {
        "s->end-0-0": {
          points: [
            { x: 0, y: 0 },
            { x: 332, y: fixture.targetY },
          ],
          isBackEdge: !fixture.expectedBack,
        },
      },
    };
    const graph = buildGraph(mergeEdgeBundle(flow), 0, null, layout);
    assertMergeEdgeStyle(graph, "s", "end", fixture.expectedBack);
    assert.deepEqual(mergeEdgeNode(graph, "end").position, layout.nodePositions.end);
    assert.deepEqual(
      mergeEdgeBetween(graph, "s", "end").data?.points,
      layout.edgeRoutes["s->end-0-0"].points,
    );
  });
}

test("buildGraph keeps unused feedback ownership independent of recorded-node order", async () => {
  // Deliberately synthetic model histories; genuine FlowRunner runs cannot visit
  // these off-start nodes. Terminal anchors expose the private feedback choice
  // without fixing unrelated unused-node positions or exporting that helper.
  const flow = mergeEdgeFlow(
    "definition-owned-feedback",
    ["s", "a", "b", "end", "x", "y"],
    [
      { from: "a", to: "b" },
      { from: "b", switch: { on: "$.route", cases: { again: "a", done: "end" } } },
    ],
  );
  const first = mergeEdgeBundle(flow, ["s", "a", "b"]);
  const second = mergeEdgeBundle(flow, ["s", "b", "a"]);
  const firstFallback = buildGraph(first, 2);
  const secondFallback = buildGraph(second, 2);
  for (const nodeId of ["a", "b"]) {
    assert.equal(
      mergeEdgeNode(firstFallback, nodeId).position.y,
      mergeEdgeNode(secondFallback, nodeId).position.y,
      `the anchored terminal tail for ${nodeId} must remain definition-owned`,
    );
  }
  assert.ok(
    mergeEdgeNode(firstFallback, "b").position.y > mergeEdgeNode(firstFallback, "a").position.y,
  );
  assertMergeEdgeStyle(firstFallback, "a", "b", false);
  assertMergeEdgeStyle(firstFallback, "b", "a", true);
  assertMergeEdgeGeometryAgreement(firstFallback, null);
  assertMergeEdgeGeometryAgreement(secondFallback, null);

  const layout = await buildGraphLayout(flow, graphMeasurements(flow));
  assert.ok(layout, "real ELK layout must succeed");
  for (const bundle of [first, second]) {
    const graph = buildGraph(bundle, 2, null, layout);
    assertMergeEdgeGeometryAgreement(graph, layout);
    for (const node of graph.nodes) {
      assert.deepEqual(node.position, layout.nodePositions[node.id]);
    }
  }
});

type ToolStatusCase = {
  name: string;
  uses: Array<{ id: string; complete?: boolean }>;
  resultId: string;
  toolUseId?: string;
  explicitStatus?: string;
  isError?: boolean;
  expected: string;
};

const toolStatusCases: ToolStatusCase[] = [
  {
    name: "known incomplete pair",
    uses: [{ id: "tool", complete: false }],
    resultId: "tool",
    expected: "running",
  },
  {
    name: "known completed legacy result",
    uses: [{ id: "tool", complete: true }],
    resultId: "tool",
    expected: "completed",
  },
  {
    name: "legacy pair without completion metadata",
    uses: [{ id: "tool" }],
    resultId: "tool",
    expected: "completed",
  },
  { name: "unpaired legacy completed result", uses: [], resultId: "legacy", expected: "completed" },
  {
    name: "incomplete pair preserves explicit completed status",
    uses: [{ id: "tool", complete: false }],
    resultId: "tool",
    explicitStatus: "completed",
    expected: "completed",
  },
  {
    name: "complete pair preserves explicit running status",
    uses: [{ id: "tool", complete: true }],
    resultId: "tool",
    explicitStatus: "running",
    expected: "running",
  },
  {
    name: "incomplete pair preserves error",
    uses: [{ id: "tool", complete: false }],
    resultId: "tool",
    isError: true,
    expected: "error",
  },
  {
    name: "explicit pair overrides complete result map key",
    uses: [
      { id: "key", complete: true },
      { id: "actual", complete: false },
    ],
    resultId: "key",
    toolUseId: "actual",
    expected: "running",
  },
  {
    name: "explicit complete pair overrides incomplete map key",
    uses: [
      { id: "key", complete: false },
      { id: "actual", complete: true },
    ],
    resultId: "key",
    toolUseId: "actual",
    expected: "completed",
  },
  {
    name: "empty explicit link stays unmatched",
    uses: [{ id: "key", complete: false }],
    resultId: "key",
    toolUseId: "",
    expected: "completed",
  },
  {
    name: "opaque own ID",
    uses: [{ id: "__proto__", complete: false }],
    resultId: "__proto__",
    expected: "running",
  },
  {
    name: "first duplicate use owns result ordering",
    uses: [
      { id: "tool", complete: true },
      { id: "tool", complete: false },
    ],
    resultId: "tool",
    expected: "completed",
  },
  {
    name: "another incomplete tool is not this result",
    uses: [{ id: "other", complete: false }],
    resultId: "legacy",
    expected: "completed",
  },
];

for (const scenario of toolStatusCases) {
  test(`viewer tool status: ${scenario.name}`, () => {
    const step = baseStep("tool_status", "acp", "ok");
    const bundle = makeBundle(step, {});
    const rawResult = {
      tool_name: "Synthetic result",
      is_error: scenario.isError ?? false,
      content: { Text: "Legacy result content" },
      ...(scenario.toolUseId === undefined ? {} : { tool_use_id: scenario.toolUseId }),
      ...(scenario.explicitStatus === undefined
        ? {}
        : { output: { status: scenario.explicitStatus } }),
    };
    const record = bundle.sessions["main-bundle"].record;
    record.messages = [
      {
        Agent: {
          content: scenario.uses.map((tool) => ({
            ToolUse: {
              id: tool.id,
              name: "Synthetic call",
              input: {},
              raw_input: "{}",
              ...(tool.complete === undefined ? {} : { is_input_complete: tool.complete }),
            },
          })),
          tool_results: Object.fromEntries([[scenario.resultId, rawResult]]),
        },
      },
    ];
    const before = structuredClone(record.messages);
    const selected = selectAttemptView(bundle, 0);
    assert.ok(selected);
    const message = selected.sessionSlice[0];
    assert.ok(message);
    const result = message.toolResults[0];
    assert.ok(result);
    assert.equal(result.status, scenario.expected);
    assert.equal(result.isError, scenario.isError ?? false);
    assert.equal(result.raw, rawResult);
    assert.deepEqual(record.messages, before);
    assert.equal(message.parts.filter((part) => part.type === "tool_result").length, 1);
    const pairedId = scenario.toolUseId ?? scenario.resultId;
    const usePosition =
      pairedId === ""
        ? -1
        : message.parts.findIndex(
            (part) => part.type === "tool_use" && part.toolUse.id === pairedId,
          );
    if (usePosition >= 0) {
      const next = message.parts[usePosition + 1];
      assert.equal(next?.type, "tool_result");
      if (next?.type === "tool_result") {
        assert.equal(next.toolResult, result);
      }
    }
  });
}
