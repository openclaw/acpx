// Exercise actual example callbacks with inert flow registration; public runtime proof is separate.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { FlowDefinition, FlowNodeContext, FlowStepRecord } from "../src/flows/types.js";

type Row = Record<string, unknown>;
type FixtureStep = {
  nodeId: string;
  output: Row;
  outcome?: FlowStepRecord["outcome"];
  at?: string;
};

async function loadConflictExample(): Promise<FlowDefinition> {
  const filename = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");
  const source = await fs.readFile(filename, "utf8");
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(parsed))
    .join("\n");
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
  const moduleSource = `const defineFlow = (definition) => definition;\n${javascript}`;
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
  )) as { default: FlowDefinition };
  return loaded.default;
}

function summaryContext(history: FixtureStep[], extraOutputs: Row = {}): FlowNodeContext {
  const timestamp = "2026-09-22T12:00:00.000Z";
  const outputs: Row = {
    prepare_workspace: {
      repo: "synthetic/repo",
      prNumber: 7,
      prUrl: "https://example.invalid/pull/7",
      workdir: "/synthetic/review-workspace",
    },
    ...extraOutputs,
  };
  const steps: FlowStepRecord[] = history.map((step, index) => {
    const outcome = step.outcome ?? "ok";
    if (outcome === "ok") {
      outputs[step.nodeId] = step.output;
    }
    return {
      attemptId: `${step.nodeId}#${index + 1}`,
      nodeId: step.nodeId,
      nodeType: step.nodeId.startsWith("check_") ? "action" : "acp",
      outcome,
      startedAt: step.at ?? timestamp,
      finishedAt: step.at ?? timestamp,
      promptText: null,
      rawText: null,
      output: step.output,
      session: null,
      agent: null,
    };
  });
  const state = {
    runId: "synthetic-conflict-summary",
    flowName: "pr-triage",
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "running" as const,
    input: null,
    outputs,
    results: {},
    steps,
    sessionBindings: {
      fixture: {
        key: "fixture",
        handle: "main",
        bundleId: "fixture-session",
        name: "main",
        agentName: "fixture",
        agentCommand: "fixture",
        cwd: "/synthetic/review-workspace",
        acpxRecordId: "fixture-record",
        acpSessionId: "fixture-backend",
      },
    },
  };
  return { input: null, outputs, results: state.results, state, services: {} };
}

async function assertConflictSurfaces(
  context: FlowNodeContext,
  initialConflict: Row | null,
  finalConflict: Row | null,
): Promise<Row> {
  const flow = await loadConflictExample();
  const before = structuredClone(context);
  const finalize = flow.nodes.finalize;
  assert(finalize?.nodeType === "compute");
  const finalSummary = (await finalize.run(context)) as Row;
  assert.deepEqual(finalSummary.initialConflict, initialConflict);
  assert.deepEqual(finalSummary.finalConflict, finalConflict);
  const common = { ...finalSummary };
  delete common.final;
  delete common.workspace;
  delete common.sessionBindings;

  for (const nodeId of [
    "comment_and_close_pr",
    "comment_and_escalate_ready_for_landing",
    "comment_and_escalate_needs_judgment",
  ]) {
    const node = flow.nodes[nodeId];
    assert(node?.nodeType === "acp");
    const prompt = await node.prompt(context);
    assert(typeof prompt === "string");
    const marker = "Use the current run state below as the source of truth:\n";
    const start = prompt.indexOf(marker);
    assert(start >= 0, nodeId);
    const end = prompt.indexOf("\nReturn exactly one JSON object and nothing else.", start);
    assert(end > start, nodeId);
    const summary = JSON.parse(prompt.slice(start + marker.length, end)) as Row;
    assert.deepEqual(summary, common, `${nodeId} must share the finalizer's summary`);
    assert.deepEqual(summary.initialConflict, initialConflict, nodeId);
    assert.deepEqual(summary.finalConflict, finalConflict, nodeId);
  }
  assert.deepEqual(context, before, "summary selection must not reorder or change run history");
  return finalSummary;
}

test("triage summaries use the successful initial resolution's recorded output", async () => {
  const resolved = {
    route: "bug_or_feature",
    summary: "Resolved, committed, pushed, and verified.",
    files_touched: ["src/synthetic.ts"],
    committed: true,
  };
  const context = summaryContext([
    {
      nodeId: "check_initial_conflicts",
      output: { conflict_status: "conflicts_detected", route: "judge_initial_conflicts" },
    },
    {
      nodeId: "judge_initial_conflicts",
      output: { conflict_assessment: "clear_resolution_path", route: "resolve_initial_conflicts" },
    },
    { nodeId: "resolve_initial_conflicts", output: resolved },
  ]);
  // Distinguish the attempt receipt from a later-mutated aggregate output map.
  context.outputs.resolve_initial_conflicts = { summary: "Aggregate-map sentinel" };
  await assertConflictSurfaces(context, resolved, null);
});

test("triage summaries preserve an initial judgment's human-decision reason", async () => {
  const judgment = {
    conflict_assessment: "needs_human_judgment",
    route: "comment_and_escalate_needs_judgment",
    reason: "Choose strict or permissive timeout semantics.",
  };
  await assertConflictSurfaces(
    summaryContext([
      {
        nodeId: "check_initial_conflicts",
        output: { conflict_status: "conflicts_detected", route: "judge_initial_conflicts" },
      },
      { nodeId: "judge_initial_conflicts", output: judgment },
    ]),
    judgment,
    null,
  );
});

test("a final clean recheck supersedes an older resolution despite backward timestamps", async () => {
  const clean = {
    conflict_status: "clean",
    route: "comment_and_escalate_ready_for_landing",
    summary: "Current base is clean.",
  };
  await assertConflictSurfaces(
    summaryContext([
      {
        nodeId: "check_final_conflicts",
        at: "2026-09-22T12:00:03.000Z",
        output: { conflict_status: "conflicts_detected" },
      },
      {
        nodeId: "judge_final_conflicts",
        at: "2026-09-22T12:00:02.000Z",
        output: { conflict_assessment: "clear_resolution_path" },
      },
      {
        nodeId: "resolve_final_conflicts",
        at: "2026-09-22T12:00:01.000Z",
        output: { route: "collect_ci_state", summary: "Resolved against earlier base." },
      },
      { nodeId: "check_final_conflicts", at: "2026-09-22T12:00:00.000Z", output: clean },
    ]),
    null,
    clean,
  );
});

test("a newer final judgment supersedes both its check and an older resolution", async () => {
  const judgment = {
    conflict_assessment: "needs_human_judgment",
    route: "comment_and_escalate_needs_judgment",
    reason: "The base changed the cancellation contract.",
  };
  await assertConflictSurfaces(
    summaryContext([
      {
        nodeId: "check_final_conflicts",
        output: { conflict_status: "conflicts_detected", summary: "Earlier base." },
      },
      { nodeId: "judge_final_conflicts", output: { conflict_assessment: "clear_resolution_path" } },
      {
        nodeId: "resolve_final_conflicts",
        output: { route: "collect_ci_state", summary: "Earlier resolution." },
      },
      {
        nodeId: "check_final_conflicts",
        output: { conflict_status: "conflicts_detected", summary: "New base conflict." },
      },
      { nodeId: "judge_final_conflicts", output: judgment },
    ]),
    null,
    judgment,
  );
});

for (const outcome of ["failed", "cancelled", "timed_out"] as const) {
  test(`a later ${outcome} conflict attempt cannot replace the last successful outcome`, async () => {
    const clean = { conflict_status: "clean", summary: "Last successfully recorded check." };
    await assertConflictSurfaces(
      summaryContext([
        { nodeId: "resolve_final_conflicts", output: { summary: "Old resolution." } },
        { nodeId: "check_final_conflicts", output: clean },
        {
          nodeId: "resolve_final_conflicts",
          outcome,
          output: { summary: "Unsuccessful-attempt sentinel" },
        },
      ]),
      null,
      clean,
    );
  });
}

test("a successful resolver callback can report that resolution needs human judgment", async () => {
  const unresolved = {
    route: "comment_and_escalate_needs_judgment",
    summary: "Cannot resolve the competing semantics safely.",
    committed: false,
  };
  await assertConflictSurfaces(
    summaryContext([
      { nodeId: "check_initial_conflicts", output: { conflict_status: "conflicts_detected" } },
      {
        nodeId: "judge_initial_conflicts",
        output: { conflict_assessment: "clear_resolution_path" },
      },
      { nodeId: "resolve_initial_conflicts", output: unresolved },
    ]),
    unresolved,
    null,
  );
});

test("shared summary keeps unvisited phases null and preserves finalizer metadata", async () => {
  const posted = {
    route: "ready_for_human_landing_decision",
    comment_path: "/synthetic/comment.md",
  };
  const context = summaryContext([], {
    extract_intent: { summary: "Intent" },
    judge_solution: { verdict: "good_enough" },
    bug_or_feature: { classification: "bug" },
    reproduce_bug_and_test_fix: { summary: "Bug validation wins." },
    test_feature_directly: { summary: "Lower-precedence feature validation." },
    judge_refactor: { refactor: "none" },
    review_loop: { review_status: "clear" },
    fix_ci_failures: { ci_status: "green_or_unrelated" },
    post_ready_for_landing_comment: posted,
    comment_and_escalate_ready_for_landing: { summary: "Unposted handoff fallback." },
  });
  const final = await assertConflictSurfaces(context, null, null);
  assert.deepEqual(final, {
    final: posted,
    intent: context.outputs.extract_intent,
    solution: context.outputs.judge_solution,
    validationPath: context.outputs.bug_or_feature,
    validation: context.outputs.reproduce_bug_and_test_fix,
    initialConflict: null,
    refactor: context.outputs.judge_refactor,
    review: context.outputs.review_loop,
    ci: context.outputs.fix_ci_failures,
    finalConflict: null,
    workspace: context.outputs.prepare_workspace,
    sessionBindings: context.state.sessionBindings,
  });
});
