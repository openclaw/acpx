import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraph,
  buildPlaybackTimeline,
  derivePlaybackPreview,
  deriveRunOutcomeView,
  formatDuration,
  formatJson,
  humanizeIdentifier,
  playbackAnchorMs,
  revealConversationSlice,
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

test("revealConversationSlice reveals ACP text progressively and hides tool noise until complete", () => {
  const step = baseStep("extract_intent", "acp", "ok");
  const bundle = makeBundle(step, {});
  const selected = selectAttemptView(bundle, 0);

  assert.ok(selected);

  const partial = revealConversationSlice(selected.sessionSlice, 0.25);

  assert.equal(partial.length, 1);
  assert.match(partial[0]?.textBlocks[0] ?? "", /^Ple/);
  assert.equal(partial[0]?.toolUses.length, 0);
  assert.equal(partial[0]?.toolResults.length, 0);

  const full = revealConversationSlice(selected.sessionSlice, 1);
  assert.equal(full.length, selected.sessionSlice.length);
  assert.equal(full[1]?.toolUses.length, 1);
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
  assert.equal(playbackAnchorMs(timeline, 0), timeline.segments[0]?.endMs);
  assert.equal(playbackAnchorMs(timeline, 1), timeline.totalDurationMs);

  const preview = derivePlaybackPreview(timeline, timeline.segments[1]!.startMs + 120);

  assert.equal(preview?.activeStepIndex, 1);
  assert.equal(preview?.nearestStepIndex, 0);
  assert.ok((preview?.stepProgress ?? 0) > 0);
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
