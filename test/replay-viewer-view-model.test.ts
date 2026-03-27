import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraph,
  deriveRunOutcomeView,
  formatDuration,
  formatJson,
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

test("buildGraph marks attempted, active, and queued nodes across switched edges", () => {
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
  const nodeStatus = new Map(graph.nodes.map((node) => [node.id, node.data.status]));
  const edgeLabels = new Map(graph.edges.map((edge) => [edge.target, edge.label]));

  assert.equal(nodeStatus.get("load_pr"), "completed");
  assert.equal(nodeStatus.get("review_loop"), "active");
  assert.equal(nodeStatus.get("check_ci"), "queued");
  assert.equal(nodeStatus.get("escalate"), "queued");
  assert.equal(edgeLabels.get("check_ci"), "clear");
  assert.equal(edgeLabels.get("escalate"), "blocked");
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

test("format helpers keep replay labels stable", () => {
  assert.equal(formatDuration(undefined), "n/a");
  assert.equal(formatDuration(500), "500 ms");
  assert.equal(formatDuration(1_500), "1.5 s");
  assert.equal(formatJson({ ok: true }), '{\n  "ok": true\n}');
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
  assert.match(outcome.headline, /Stopped at review_loop/);
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
