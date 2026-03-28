import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJsonObject } from "../../../src/flows.js";
import { selectLocalCodexReviewText } from "./review-text.js";

const FLOW_DIR = ".acpx-flow";
const MAIN_SESSION = {
  handle: "main",
};

const flow = {
  name: "pr-triage",
  permissions: {
    requiredMode: "approve-all",
    requireExplicitGrant: true,
    reason:
      "This flow edits files, pushes commits, comments on pull requests, and may approve CI workflow runs.",
  },
  startAt: "load_pr",
  nodes: {
    load_pr: {
      nodeType: "compute",
      run: ({ input }) => loadPullRequestInput(input),
    },

    prepare_workspace: {
      nodeType: "action",
      timeoutMs: 20 * 60_000,
      statusDetail: "Create isolated PR workspace and fetch GitHub context",
      run: async ({ outputs }) => await prepareWorkspace(loadPrOutput(outputs)),
    },

    extract_intent: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptExtractIntent(prepared(outputs));
      },
      parse: (text) => extractJsonObject(text),
    },

    judge_solution: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptJudgeSolution(prepared(outputs));
      },
      parse: (text) => extractJsonObject(text),
    },

    check_initial_conflicts: {
      nodeType: "action",
      timeoutMs: 20 * 60_000,
      statusDetail: "Check conflict status against the current base before validation",
      run: async ({ outputs }) =>
        await collectConflictState(prepared(outputs), {
          phase: "initial",
        }),
    },

    judge_initial_conflicts: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 20 * 60_000,
      async prompt({ outputs }) {
        return promptJudgeInitialConflicts(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    resolve_initial_conflicts: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 30 * 60_000,
      async prompt({ outputs }) {
        return promptResolveInitialConflicts(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    bug_or_feature: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptBugOrFeature(prepared(outputs));
      },
      parse: (text) => extractJsonObject(text),
    },

    reproduce_bug_and_test_fix: {
      nodeType: "action",
      timeoutMs: 30 * 60_000,
      statusDetail: "Reproduce the bug and validate the fix in the isolated workspace",
      run: async ({ outputs }) =>
        await reproduceBugAndTestFix(prepared(outputs), outputs.bug_or_feature),
    },

    test_feature_directly: {
      nodeType: "action",
      timeoutMs: 25 * 60_000,
      statusDetail: "Run direct feature validation in the isolated workspace",
      run: async ({ outputs }) =>
        await testFeatureDirectly(prepared(outputs), outputs.bug_or_feature),
    },

    judge_refactor: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptJudgeRefactor(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    do_superficial_refactor: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 25 * 60_000,
      async prompt({ outputs }) {
        return promptDoSuperficialRefactor(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    collect_review_state: {
      nodeType: "action",
      timeoutMs: 60 * 60_000,
      statusDetail: "Collect GitHub review state and run local Codex review",
      run: async ({ outputs }) => await collectReviewState(prepared(outputs)),
    },

    review_loop: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 90 * 60_000,
      async prompt({ outputs }) {
        return promptReviewLoop(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    collect_ci_state: {
      nodeType: "action",
      timeoutMs: 15 * 60_000,
      statusDetail: "Collect CI state and approve workflow runs when possible",
      run: async ({ outputs }) => await collectCiState(prepared(outputs)),
    },

    fix_ci_failures: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 60 * 60_000,
      async prompt({ outputs }) {
        return promptFixCiFailures(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    check_final_conflicts: {
      nodeType: "action",
      timeoutMs: 20 * 60_000,
      statusDetail: "Check conflict status against the current base before final handoff",
      run: async ({ outputs }) =>
        await collectConflictState(prepared(outputs), {
          phase: "final",
        }),
    },

    judge_final_conflicts: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 20 * 60_000,
      async prompt({ outputs }) {
        return promptJudgeFinalConflicts(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    resolve_final_conflicts: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      timeoutMs: 30 * 60_000,
      async prompt({ outputs }) {
        return promptResolveFinalConflicts(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    comment_and_close_pr: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptCommentAndClose(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    post_close_pr: {
      nodeType: "action",
      timeoutMs: 15 * 60_000,
      statusDetail: "Post close comment and close the PR",
      run: async ({ outputs }) =>
        await postClosePr(prepared(outputs), outputs.comment_and_close_pr),
    },

    comment_and_escalate_to_human: {
      nodeType: "acp",
      session: MAIN_SESSION,
      cwd: ({ outputs }) => prepared(outputs).workdir,
      async prompt({ outputs }) {
        return promptCommentAndEscalate(prepared(outputs), outputs);
      },
      parse: (text) => extractJsonObject(text),
    },

    post_escalation_comment: {
      nodeType: "action",
      timeoutMs: 10 * 60_000,
      statusDetail: "Post human handoff comment",
      run: async ({ outputs }) =>
        await postEscalationComment(prepared(outputs), outputs.comment_and_escalate_to_human),
    },

    finalize: {
      nodeType: "compute",
      run: ({ outputs, state }) => ({
        final:
          outputs.post_close_pr ??
          outputs.post_escalation_comment ??
          outputs.comment_and_close_pr ??
          outputs.comment_and_escalate_to_human ??
          null,
        intent: outputs.extract_intent ?? null,
        solution: outputs.judge_solution ?? null,
        validationPath: outputs.bug_or_feature ?? null,
        validation: outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null,
        initialConflict:
          outputs.check_initial_conflicts ??
          outputs.judge_initial_conflicts ??
          outputs.resolve_initial_conflicts ??
          null,
        refactor: outputs.judge_refactor ?? null,
        review: outputs.review_loop ?? null,
        ci: outputs.fix_ci_failures ?? null,
        finalConflict:
          outputs.check_final_conflicts ??
          outputs.judge_final_conflicts ??
          outputs.resolve_final_conflicts ??
          null,
        workspace: outputs.prepare_workspace ?? null,
        sessionBindings: state.sessionBindings,
      }),
    },
  },
  edges: [
    { from: "load_pr", to: "prepare_workspace" },
    { from: "prepare_workspace", to: "extract_intent" },
    { from: "extract_intent", to: "judge_solution" },
    {
      from: "judge_solution",
      switch: {
        on: "$.route",
        cases: {
          close_pr: "comment_and_close_pr",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
          bug_or_feature: "check_initial_conflicts",
        },
      },
    },
    {
      from: "check_initial_conflicts",
      switch: {
        on: "$.route",
        cases: {
          bug_or_feature: "bug_or_feature",
          judge_initial_conflicts: "judge_initial_conflicts",
        },
      },
    },
    {
      from: "judge_initial_conflicts",
      switch: {
        on: "$.route",
        cases: {
          resolve_initial_conflicts: "resolve_initial_conflicts",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "resolve_initial_conflicts",
      switch: {
        on: "$.route",
        cases: {
          bug_or_feature: "bug_or_feature",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "bug_or_feature",
      switch: {
        on: "$.route",
        cases: {
          reproduce_bug_and_test_fix: "reproduce_bug_and_test_fix",
          test_feature_directly: "test_feature_directly",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "reproduce_bug_and_test_fix",
      switch: {
        on: "$.route",
        cases: {
          judge_refactor: "judge_refactor",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "test_feature_directly",
      switch: {
        on: "$.route",
        cases: {
          judge_refactor: "judge_refactor",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "judge_refactor",
      switch: {
        on: "$.route",
        cases: {
          collect_review_state: "collect_review_state",
          do_superficial_refactor: "do_superficial_refactor",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    { from: "do_superficial_refactor", to: "collect_review_state" },
    { from: "collect_review_state", to: "review_loop" },
    {
      from: "review_loop",
      switch: {
        on: "$.route",
        cases: {
          collect_review_state: "collect_review_state",
          collect_ci_state: "collect_ci_state",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    { from: "collect_ci_state", to: "fix_ci_failures" },
    {
      from: "fix_ci_failures",
      switch: {
        on: "$.route",
        cases: {
          check_final_conflicts: "check_final_conflicts",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    {
      from: "check_final_conflicts",
      switch: {
        on: "$.route",
        cases: {
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
          judge_final_conflicts: "judge_final_conflicts",
        },
      },
    },
    {
      from: "judge_final_conflicts",
      switch: {
        on: "$.route",
        cases: {
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
          resolve_final_conflicts: "resolve_final_conflicts",
        },
      },
    },
    {
      from: "resolve_final_conflicts",
      switch: {
        on: "$.route",
        cases: {
          collect_ci_state: "collect_ci_state",
          comment_and_escalate_to_human: "comment_and_escalate_to_human",
        },
      },
    },
    { from: "comment_and_close_pr", to: "post_close_pr" },
    { from: "post_close_pr", to: "finalize" },
    { from: "comment_and_escalate_to_human", to: "post_escalation_comment" },
    { from: "post_escalation_comment", to: "finalize" },
  ],
};

export default flow;

async function prepareWorkspace(pr) {
  const prData = await ghApiJson(`repos/${pr.repo}/pulls/${pr.prNumber}`);
  const files = await ghApiJson(`repos/${pr.repo}/pulls/${pr.prNumber}/files?per_page=100`);
  const linkedIssueNumber = extractLinkedIssueNumber(String(prData.body ?? ""));
  const issue =
    linkedIssueNumber !== null
      ? await ghApiJson(`repos/${pr.repo}/issues/${linkedIssueNumber}`)
      : null;

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `acpx-pr${pr.prNumber}-`));
  const baseCloneUrl = String(prData.base.repo.clone_url);
  const headCloneUrl = String(prData.head.repo.clone_url);
  const baseRef = String(prData.base.ref);
  const headRef = String(prData.head.ref);
  const headSha = String(prData.head.sha);
  const localBranch = `pr-${pr.prNumber}-head`;
  const pushRemote = headCloneUrl === baseCloneUrl ? "origin" : "head";

  await runCommand("git", ["clone", "--origin", "origin", baseCloneUrl, workdir]);

  if (pushRemote === "head") {
    await runCommand("git", ["-C", workdir, "remote", "add", "head", headCloneUrl]);
  }

  await runCommand("git", [
    "-C",
    workdir,
    "fetch",
    "origin",
    `refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
  ]);
  await runCommand("git", [
    "-C",
    workdir,
    "fetch",
    pushRemote,
    `refs/heads/${headRef}:refs/remotes/${pushRemote}/${headRef}`,
  ]);
  await runCommand("git", ["-C", workdir, "checkout", "-B", localBranch, headSha]);
  await runCommand("git", [
    "-C",
    workdir,
    "branch",
    "--set-upstream-to",
    `${pushRemote}/${headRef}`,
    localBranch,
  ]);

  const metaDir = path.join(workdir, FLOW_DIR);
  await fs.mkdir(metaDir, { recursive: true });
  await writeJson(path.join(metaDir, "pr.json"), prData);
  await writeJson(path.join(metaDir, "files.json"), files);
  await writeJson(path.join(metaDir, "issue.json"), issue);
  await writeJson(path.join(metaDir, "workspace.json"), {
    repo: pr.repo,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    workdir,
    baseRef,
    headRef,
    headSha,
    localBranch,
    pushRemote,
    pushRef: headRef,
    isCrossRepository: Boolean(prData.head.repo.full_name !== prData.base.repo.full_name),
  });

  return {
    ...pr,
    title: String(prData.title ?? ""),
    body: String(prData.body ?? ""),
    baseRef,
    headRef,
    headSha,
    localBranch,
    pushRemote,
    pushRef: headRef,
    workdir,
    flowDir: metaDir,
    linkedIssueNumber,
    changedFiles: Array.isArray(files) ? files : [],
    isCrossRepository: Boolean(prData.head.repo.full_name !== prData.base.repo.full_name),
  };
}

async function reproduceBugAndTestFix(pr, validationPath) {
  if (validationPath?.classification !== "bug") {
    throw new Error("Bug validation action requires bug validation path");
  }

  await ensureProjectDependencies(pr.workdir);
  const testPlan = buildTargetedTestPlan(pr.changedFiles);
  if (testPlan.commands.length === 0) {
    return {
      validation_status: "fix_not_proven",
      route: "comment_and_escalate_to_human",
      summary: "No targeted test command could be derived from the PR changes.",
      repro_steps: [],
      targeted_tests: [],
      integration_tests: [],
      e2e_tests: [],
      restored_branch_state: true,
    };
  }

  const codeFiles = pr.changedFiles
    .map((file) => String(file.filename ?? ""))
    .filter((filename) => filename && !isTestFile(filename));
  if (codeFiles.length === 0) {
    return {
      validation_status: "fix_not_proven",
      route: "comment_and_escalate_to_human",
      summary:
        "Could not isolate a non-test code change to ablate while keeping the new validation intact.",
      repro_steps: [],
      targeted_tests: testPlan.commands,
      integration_tests: [],
      e2e_tests: [],
      restored_branch_state: true,
    };
  }

  const baseRef = `origin/${pr.baseRef}`;
  await runCommand("git", ["-C", pr.workdir, "fetch", "origin", pr.baseRef]);
  const mergeBase = (
    await runCommand("git", ["-C", pr.workdir, "merge-base", "HEAD", baseRef])
  ).stdout.trim();
  const patch = (
    await runCommand("git", [
      "-C",
      pr.workdir,
      "diff",
      "--binary",
      `${mergeBase}..HEAD`,
      "--",
      ...codeFiles,
    ])
  ).stdout;
  if (!patch.trim()) {
    return {
      validation_status: "fix_not_proven",
      route: "comment_and_escalate_to_human",
      summary: "Could not derive an ablation patch for the non-test code changes in this PR.",
      repro_steps: [],
      targeted_tests: testPlan.commands,
      integration_tests: [],
      e2e_tests: [],
      restored_branch_state: true,
    };
  }

  const initial = await runValidationPlan(pr.workdir, testPlan.commands);
  if (!initial.ok) {
    return {
      validation_status: "fix_not_proven",
      route: "comment_and_escalate_to_human",
      summary:
        "The targeted validation did not pass on the PR head before ablation, so the fix could not be proven.",
      repro_steps: [],
      targeted_tests: testPlan.commands,
      integration_tests: [],
      e2e_tests: [],
      restored_branch_state: true,
    };
  }

  const patchPath = path.join(pr.flowDir, "ablation.patch");
  await fs.writeFile(patchPath, patch, "utf8");
  await runCommand("git", ["-C", pr.workdir, "apply", "-R", patchPath]);
  const ablated = await runValidationPlan(pr.workdir, testPlan.commands, {
    allowFailure: true,
  });
  await runCommand("git", ["-C", pr.workdir, "reset", "--hard", "HEAD"]);

  const restored = await runValidationPlan(pr.workdir, testPlan.commands);
  const reproduced = !ablated.ok;

  return {
    validation_status: reproduced && restored.ok ? "reproduced_and_fixed" : "fix_not_proven",
    route: reproduced && restored.ok ? "judge_refactor" : "comment_and_escalate_to_human",
    summary:
      reproduced && restored.ok
        ? "The targeted regression test passed on the PR head, failed after local-only ablation of the code change, and passed again after restoring the PR branch state."
        : "The bug could not be shown to fail on the local-only ablated state and pass again on the restored PR head.",
    repro_steps: [
      `Ran targeted validation on PR head in ${path.basename(pr.workdir)}`,
      "Reverse-applied the non-test code patch locally without committing or pushing it",
      "Reran the same targeted validation on the ablated state",
      "Restored the tracked PR branch state with git reset --hard HEAD",
      "Reran the same targeted validation on the restored PR head",
    ],
    targeted_tests: testPlan.commands,
    integration_tests: [],
    e2e_tests: [],
    restored_branch_state: true,
  };
}

async function testFeatureDirectly(pr, validationPath) {
  if (validationPath?.classification !== "feature") {
    throw new Error("Feature validation action requires feature validation path");
  }

  await ensureProjectDependencies(pr.workdir);
  const testPlan = buildTargetedTestPlan(pr.changedFiles);
  if (testPlan.commands.length === 0) {
    return {
      validation_status: "feature_not_validated",
      route: "comment_and_escalate_to_human",
      summary: "No targeted test command could be derived for direct feature validation.",
      targeted_tests: [],
      integration_tests: [],
      e2e_tests: [],
    };
  }

  const result = await runValidationPlan(pr.workdir, testPlan.commands, {
    allowFailure: true,
  });
  return {
    validation_status: result.ok ? "feature_validated" : "feature_not_validated",
    route: result.ok ? "judge_refactor" : "comment_and_escalate_to_human",
    summary: result.ok
      ? "The targeted feature validation passed on the PR branch."
      : "The targeted feature validation did not complete cleanly on the PR branch.",
    targeted_tests: testPlan.commands,
    integration_tests: [],
    e2e_tests: [],
  };
}

async function collectReviewState(pr) {
  const reviews = await ghApiJson(`repos/${pr.repo}/pulls/${pr.prNumber}/reviews?per_page=100`);
  const reviewComments = await ghApiJson(
    `repos/${pr.repo}/pulls/${pr.prNumber}/comments?per_page=100`,
  );
  const issueComments = await ghApiJson(
    `repos/${pr.repo}/issues/${pr.prNumber}/comments?per_page=100`,
  );

  await runCommand("git", ["-C", pr.workdir, "fetch", "origin", pr.baseRef]);
  const baseRef = `origin/${pr.baseRef}`;
  const mergeBase = (
    await runCommand("git", ["-C", pr.workdir, "merge-base", "HEAD", baseRef])
  ).stdout.trim();

  const localReviewCommand = ["review", "--base", baseRef];
  const localReviewRun = await runCommand("codex", localReviewCommand, {
    cwd: pr.workdir,
    allowFailure: true,
    timeoutMs: 30 * 60_000,
  });
  const localReviewStdout = trimTextTail(localReviewRun.stdout, 16_000);
  const localReviewStderr = trimTextTail(localReviewRun.stderr, 16_000);
  const localReviewText = trimTextTail(
    selectLocalCodexReviewText(localReviewRun.stdout, localReviewRun.stderr),
    16_000,
  );

  const reviewState = {
    baseRef,
    mergeBase,
    githubReviews: Array.isArray(reviews) ? reviews.map(normalizeGitHubReview) : [],
    githubReviewComments: Array.isArray(reviewComments)
      ? reviewComments.map(normalizeGitHubReviewComment)
      : [],
    githubIssueComments: Array.isArray(issueComments)
      ? issueComments.map(normalizeGitHubIssueComment)
      : [],
    localCodexReviewText: localReviewText,
    localCodexReviewStdout: localReviewStdout,
    localCodexReviewStderr: localReviewStderr,
    localCodexReviewAvailable: Boolean(localReviewText),
    localCodexReviewExitCode: localReviewRun.exitCode,
    localCodexReviewTimedOut: localReviewRun.timedOut,
  };
  await writeJson(path.join(pr.flowDir, "review-state.json"), reviewState);

  return {
    review_state_path: path.join(pr.flowDir, "review-state.json"),
    local_codex_review_ran: true,
    local_codex_review_exit_code: localReviewRun.exitCode,
    local_codex_review_available: Boolean(localReviewText),
  };
}

async function collectCiState(pr) {
  const prView = await ghPrView(pr.repo, pr.prNumber, [
    "statusCheckRollup",
    "commits",
    "isCrossRepository",
  ]);
  const headSha = String(prView?.commits?.[0]?.oid ?? pr.headSha) || pr.headSha;
  const workflowRuns = await ghApiJson(
    `repos/${pr.repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=20`,
  );
  const runs = Array.isArray(workflowRuns?.workflow_runs) ? workflowRuns.workflow_runs : [];

  const ciState = {
    statusCheckRollup: Array.isArray(prView?.statusCheckRollup) ? prView.statusCheckRollup : [],
    workflowRuns: runs,
  };
  await writeJson(path.join(pr.flowDir, "ci-state.json"), ciState);

  return {
    ci_state_path: path.join(pr.flowDir, "ci-state.json"),
  };
}

async function collectConflictState(pr, options) {
  const baseRef = `origin/${pr.baseRef}`;
  await cleanupMergeState(pr.workdir);
  await runCommand("git", ["-C", pr.workdir, "fetch", "origin", pr.baseRef]);

  const attempt = await runCommand(
    "git",
    ["-C", pr.workdir, "merge", "--no-commit", "--no-ff", baseRef],
    {
      allowFailure: true,
    },
  );

  const conflictedFiles = (
    await runCommand("git", ["-C", pr.workdir, "diff", "--name-only", "--diff-filter=U"], {
      allowFailure: true,
    })
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const clean = attempt.exitCode === 0;
  const conflictStatus = clean ? "clean" : "conflicts_detected";
  const route = clean
    ? options.phase === "initial"
      ? "bug_or_feature"
      : "comment_and_escalate_to_human"
    : options.phase === "initial"
      ? "judge_initial_conflicts"
      : "judge_final_conflicts";

  const conflictState = {
    phase: options.phase,
    baseRef,
    conflict_status: conflictStatus,
    route,
    conflicted_files: conflictedFiles,
    merge_attempt_exit_code: attempt.exitCode,
    merge_attempt_stdout: trimTextTail(attempt.stdout, 8_000),
    merge_attempt_stderr: trimTextTail(attempt.stderr, 8_000),
  };
  const statePath = path.join(pr.flowDir, `${options.phase}-conflict-state.json`);
  await writeJson(statePath, conflictState);

  if (clean) {
    await cleanupMergeState(pr.workdir);
  }

  return {
    ...conflictState,
    conflict_state_path: statePath,
    summary:
      conflictStatus === "clean"
        ? `No conflicts were detected against ${baseRef}.`
        : `Conflicts were detected against ${baseRef} and need conflict judgment before the flow can continue.`,
  };
}

async function postClosePr(pr, commentStep) {
  const comment = String(commentStep?.comment ?? "").trim();
  if (!comment) {
    throw new Error("Close-path comment step did not return a comment body");
  }

  const commentFile = path.join(pr.flowDir, "close-comment.md");
  await fs.writeFile(commentFile, comment, "utf8");
  await runCommand("gh", [
    "pr",
    "comment",
    String(pr.prNumber),
    "--repo",
    pr.repo,
    "--body-file",
    commentFile,
  ]);
  await runCommand("gh", [
    "pr",
    "close",
    String(pr.prNumber),
    "--repo",
    pr.repo,
    "--comment",
    "Closed by automated triage.",
  ]);
  return {
    route: "close_pr",
    summary: "Posted the close-path comment and closed the PR.",
    comment_posted: true,
    pr_closed: true,
  };
}

async function postEscalationComment(pr, commentStep) {
  const comment = String(commentStep?.comment ?? "").trim();
  if (!comment) {
    throw new Error("Escalation comment step did not return a comment body");
  }

  const commentFile = path.join(pr.flowDir, "escalation-comment.md");
  await fs.writeFile(commentFile, comment, "utf8");
  await runCommand("gh", [
    "pr",
    "comment",
    String(pr.prNumber),
    "--repo",
    pr.repo,
    "--body-file",
    commentFile,
  ]);
  return {
    route: "escalate_to_human",
    summary: "Posted the human handoff comment.",
    comment_posted: true,
  };
}

function promptExtractIntent(pr) {
  return [
    "You are processing one pull request at a time in an isolated workspace already prepared by the flow runtime.",
    `Target PR: ${prRef(pr)}`,
    `Working directory: ${pr.workdir}`,
    `Read local context from ${FLOW_DIR}/pr.json, ${FLOW_DIR}/issue.json, ${FLOW_DIR}/files.json, and ${FLOW_DIR}/workspace.json.`,
    "Inspect the checked-out repo and current diff yourself when needed. Do not ask the runtime to fetch more context.",
    "This is a read-only judgment step. Do not run installs, tests, CI checks, Codex review, or GitHub API commands here.",
    "Extract the plain-language human intent and the underlying problem.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "intent": "plain-language human goal",',
      '  "problem": "short description of the underlying issue",',
      '  "confidence": 0.0,',
      '  "reason": "short explanation"',
      "}",
    ]),
  ].join("\n");
}

function promptJudgeSolution(pr) {
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `Use the checked-out repo and the local context files under ${FLOW_DIR}/.`,
    "This is a read-only judgment step. Do not run installs, tests, CI checks, Codex review, or GitHub API commands here.",
    "The validation and review mechanics happen in later flow steps; do not start them now.",
    "Judge whether this PR is a good solution to the underlying problem.",
    "Use these verdicts:",
    '- "good_enough" if the solution is right-shaped and can continue.',
    '- "localized_fix" if it only treats a symptom or is too local for the real problem.',
    '- "bad_fix" if it is solving the wrong problem or is the wrong approach.',
    '- "unclear" if the PR is too unclear to evaluate confidently.',
    '- "needs_human_call" if it seems plausible but needs a design decision or human call before continuing.',
    "Route `close_pr` for localized_fix, bad_fix, or unclear.",
    "Route `comment_and_escalate_to_human` for needs_human_call.",
    "Route `bug_or_feature` for good_enough. The conflict gate runs immediately after this step.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "verdict": "good_enough" | "localized_fix" | "bad_fix" | "unclear" | "needs_human_call",',
      '  "route": "close_pr" | "comment_and_escalate_to_human" | "bug_or_feature",',
      '  "reason": "short explanation",',
      '  "evidence": ["brief evidence item"]',
      "}",
    ]),
  ].join("\n");
}

function promptBugOrFeature(pr) {
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `Use the checked-out repo plus ${FLOW_DIR}/pr.json and ${FLOW_DIR}/issue.json.`,
    "This is a read-only classification step. Do not run installs, tests, CI checks, Codex review, or GitHub API commands here.",
    "Decide which validation path this PR should take before refactor or review.",
    "Use `bug` if this PR primarily claims to fix a bug, regression, broken behavior, or other issue that should first be reproduced and then proven fixed.",
    "Use `feature` if this PR primarily adds or changes behavior that should be validated directly without first reproducing a prior failure.",
    "If you cannot classify it confidently, route to `comment_and_escalate_to_human`.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "classification": "bug" | "feature" | "unclear",',
      '  "route": "reproduce_bug_and_test_fix" | "test_feature_directly" | "comment_and_escalate_to_human",',
      '  "reason": "short explanation"',
      "}",
    ]),
  ].join("\n");
}

function promptJudgeInitialConflicts(pr, outputs) {
  const conflictStatePath =
    outputs.check_initial_conflicts?.conflict_state_path ??
    `${FLOW_DIR}/initial-conflict-state.json`;
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `The runtime already attempted a merge against the current base and left the worktree in the conflict state. Read ${conflictStatePath} for the conflict summary and inspect the conflicted files directly in the repo.`,
    "Decide whether the conflict has a clear resolution path or needs human judgment.",
    "Use `clear_resolution_path` if the correct merged result is apparent from the PR intent plus the current base, even when code moved or was refactored.",
    "Use `needs_human_judgment` if resolving the conflict requires choosing behavior, design, or architecture rather than integrating both sides safely.",
    "If the correct move is to keep the current-base refactor and port the PR's behavior into the new structure, that still counts as `clear_resolution_path`.",
    "Route `resolve_initial_conflicts` for `clear_resolution_path`.",
    "Route `comment_and_escalate_to_human` for `needs_human_judgment`.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "conflict_assessment": "clear_resolution_path" | "needs_human_judgment",',
      '  "route": "resolve_initial_conflicts" | "comment_and_escalate_to_human",',
      '  "reason": "short explanation"',
      "}",
    ]),
  ].join("\n");
}

function promptResolveInitialConflicts(pr, outputs) {
  const conflictStatePath =
    outputs.check_initial_conflicts?.conflict_state_path ??
    `${FLOW_DIR}/initial-conflict-state.json`;
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `The runtime already prepared a merge-conflict state for this PR. Read ${conflictStatePath} for the conflict summary and inspect the conflicted files directly in the repo.`,
    `Use the local branch ${pr.localBranch}. If you need to push, use remote ${pr.pushRemote} branch ${pr.pushRef}.`,
    "Resolve the conflict only because you already judged that it has a clear resolution path while preserving the intended PR behavior.",
    "If you cannot resolve the conflicts confidently, do not guess. Route to `comment_and_escalate_to_human` instead.",
    "If you resolve them, finish the merge, run focused checks when feasible, commit the merge result if needed, push the branch yourself, and route to `bug_or_feature`.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "bug_or_feature" | "comment_and_escalate_to_human",',
      '  "summary": "short explanation",',
      '  "files_touched": ["path/to/file"],',
      '  "committed": true | false',
      "}",
    ]),
  ].join("\n");
}

function promptJudgeRefactor(pr, outputs) {
  const validation = outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null;
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    "The validation step has already been run by the flow runtime.",
    `Validation summary: ${validation?.summary ?? "none"}`,
    "This is a read-only judgment step. Do not rerun validation, CI checks, Codex review, or GitHub API commands here.",
    "Judge whether this PR needs no refactor, a superficial refactor, or a fundamental refactor.",
    "Route `collect_review_state` for none.",
    "Route `do_superficial_refactor` for superficial.",
    "Route `comment_and_escalate_to_human` for fundamental.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "refactor_needed": "none" | "superficial" | "fundamental",',
      '  "route": "collect_review_state" | "do_superficial_refactor" | "comment_and_escalate_to_human",',
      '  "reason": "short explanation"',
      "}",
    ]),
  ].join("\n");
}

function promptDoSuperficialRefactor(pr) {
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `Use the local branch ${pr.localBranch}. If you need to push, use remote ${pr.pushRemote} branch ${pr.pushRef}.`,
    "Perform only the superficial refactor directly in the checked-out repo.",
    "Keep it minor and maintainability-focused. Do not reframe the problem or turn this into a fundamental rewrite.",
    "If you change files, run focused checks when feasible, rerun the earlier targeted validation before returning, then commit and push the branch yourself.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "collect_review_state",',
      '  "summary": "short explanation",',
      '  "files_touched": ["path/to/file"],',
      '  "committed": true | false',
      "}",
    ]),
  ].join("\n");
}

function promptReviewLoop(pr, outputs) {
  const reviewStatePath =
    outputs.collect_review_state?.review_state_path ?? `${FLOW_DIR}/review-state.json`;
  const validation = outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null;
  return [
    "Stay on the autonomous review lane for this single PR.",
    `Target PR: ${prRef(pr)}`,
    `The review mechanics have already been collected by the flow runtime in ${reviewStatePath}.`,
    "Read that local JSON file and the local repo state instead of rerunning `gh api` or `codex review` yourself.",
    "Use only the normalized GitHub review data and the stored local Codex review text from that file as review evidence.",
    "Top-level GitHub issue comments count only if they clearly contain Codex-authored review feedback for the current head. Ignore plain handoff or status comments.",
    `Use the local branch ${pr.localBranch}. If you need to push, use remote ${pr.pushRemote} branch ${pr.pushRef}.`,
    "First, inspect the existing GitHub Codex review data already collected for the current PR head.",
    "Then inspect the fresh local Codex review text that was already run against the refreshed base ref.",
    "The local Codex review is plain text, not structured JSON. Read `localCodexReviewText`, and use `localCodexReviewStdout` and `localCodexReviewStderr` only as fallback context if needed.",
    "If valid P0 or P1 issues remain from either source, fix them directly in the repo, run focused checks when feasible, commit and push the branch yourself, and then route back to `collect_review_state` so the flow runtime can rerun the review mechanics.",
    "Do not keep looping just because only P2 or lower findings remain. Treat P2 and lower as non-blocking unless they materially change your judgment about whether the PR is safe to continue.",
    `If you change code in this loop, rerun the earlier targeted validation before returning. Latest validation summary: ${validation?.summary ?? "none"}.`,
    "Treat the local Codex review as established if `localCodexReviewExitCode` is zero, `localCodexReviewTimedOut` is false, and there is substantive review text available.",
    "Only route to `comment_and_escalate_to_human` if the local Codex review actually failed, timed out, or produced no usable review text at all.",
    "If blocking review findings are cleared, route to `collect_ci_state`.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "collect_review_state" | "collect_ci_state" | "comment_and_escalate_to_human",',
      '  "review_status": "blocking_findings_remain" | "clear" | "could_not_establish",',
      '  "summary": "short explanation",',
      '  "github_codex_reviews_handled": true | false,',
      '  "local_codex_review_ran": true | false,',
      '  "blocking_findings": ["brief finding"],',
      '  "committed": true | false',
      "}",
    ]),
  ].join("\n");
}

function promptFixCiFailures(pr, outputs) {
  const ciStatePath = outputs.collect_ci_state?.ci_state_path ?? `${FLOW_DIR}/ci-state.json`;
  const validation = outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null;
  return [
    "Stay on the autonomous CI lane for this single PR.",
    `Target PR: ${prRef(pr)}`,
    `The CI mechanics have already been collected by the flow runtime in ${ciStatePath}.`,
    "Start from that local JSON file and the checked-out repo state, then own the CI lane yourself until it reaches a stable green outcome or a real blocker forces escalation.",
    `Use the local branch ${pr.localBranch}. If you need to push, use remote ${pr.pushRemote} branch ${pr.pushRef}.`,
    "If any relevant GitHub Actions workflow run is approval-blocked, approve it immediately yourself with `gh api -X POST repos/{owner}/{repo}/actions/runs/{run_id}/approve` before making any escalation decision.",
    "Treat a workflow run as approval-blocked when its state clearly shows `action_required`, including cases where that appears in the conclusion rather than the status.",
    "Do not bounce back to `collect_ci_state` just to wait for CI. If a relevant workflow run is queued or in progress, monitor it yourself with `gh run watch`, `gh pr checks --watch`, or direct `gh api` polling until it reaches a terminal state.",
    "If you approve a blocked workflow run successfully, keep monitoring inside this same step until the rerun finishes green, surfaces a real related failure, or hits a real platform/permission blocker.",
    "If related failures remain and you can fix them, fix them directly in the repo, run focused checks when feasible, rerun the earlier targeted validation, commit and push the branch yourself, rerun or monitor CI yourself, and stay in this same step until the updated CI reaches a terminal state.",
    "Only return from this step once CI is actually green/unrelated, or once you have a real reason that a human must take over.",
    `Latest validation summary: ${validation?.summary ?? "none"}.`,
    "If CI is green or the remaining failures are clearly unrelated, route to `check_final_conflicts` so the final conflict gate can run before the human handoff.",
    "Only route to `comment_and_escalate_to_human` for workflow approval if you actually tried to approve the blocked run and could not clear it because of a real permission or platform failure.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "check_final_conflicts" | "comment_and_escalate_to_human",',
      '  "ci_status": "related_failures_remain" | "green_or_unrelated" | "approval_blocked",',
      '  "summary": "short explanation",',
      '  "related_failures": ["brief failure"],',
      '  "unrelated_failures": ["brief failure"],',
      '  "workflow_approval_attempted": true | false,',
      '  "workflow_approved": true | false,',
      '  "committed": true | false',
      "}",
    ]),
  ].join("\n");
}

function promptJudgeFinalConflicts(pr, outputs) {
  const conflictStatePath =
    outputs.check_final_conflicts?.conflict_state_path ?? `${FLOW_DIR}/final-conflict-state.json`;
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `The runtime already attempted a merge against the current base and left the worktree in the conflict state. Read ${conflictStatePath} for the conflict summary and inspect the conflicted files directly in the repo.`,
    "Decide whether the conflict has a clear resolution path or needs human judgment.",
    "Use `clear_resolution_path` if the correct merged result is apparent from the PR intent plus the current base, even when code moved or was refactored.",
    "Use `needs_human_judgment` if resolving the conflict requires choosing behavior, design, or architecture rather than integrating both sides safely.",
    "If the correct move is to keep the current-base refactor and port the PR's behavior into the new structure, that still counts as `clear_resolution_path`.",
    "Route `resolve_final_conflicts` for `clear_resolution_path`.",
    "Route `comment_and_escalate_to_human` for `needs_human_judgment`.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "conflict_assessment": "clear_resolution_path" | "needs_human_judgment",',
      '  "route": "resolve_final_conflicts" | "comment_and_escalate_to_human",',
      '  "reason": "short explanation"',
      "}",
    ]),
  ].join("\n");
}

function promptResolveFinalConflicts(pr, outputs) {
  const conflictStatePath =
    outputs.check_final_conflicts?.conflict_state_path ?? `${FLOW_DIR}/final-conflict-state.json`;
  const validation = outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null;
  return [
    "You are still in the same PR session inside the isolated workspace.",
    `Target PR: ${prRef(pr)}`,
    `The runtime already prepared a merge-conflict state for this PR. Read ${conflictStatePath} for the conflict summary and inspect the conflicted files directly in the repo.`,
    `Use the local branch ${pr.localBranch}. If you need to push, use remote ${pr.pushRemote} branch ${pr.pushRef}.`,
    "Resolve the conflict only because you already judged that it has a clear resolution path while preserving the intended PR behavior.",
    "If you cannot resolve the conflicts confidently, do not guess. Route to `comment_and_escalate_to_human` instead.",
    `If you resolve them, rerun the earlier targeted validation before returning. Latest validation summary: ${validation?.summary ?? "none"}.`,
    "After resolving and pushing the branch, route back to `collect_ci_state` so the flow runtime can rerun the final CI path.",
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "collect_ci_state" | "comment_and_escalate_to_human",',
      '  "summary": "short explanation",',
      '  "files_touched": ["path/to/file"],',
      '  "committed": true | false',
      "}",
    ]),
  ].join("\n");
}

function promptCommentAndClose(pr, outputs) {
  const summary = finalCommentSummary(outputs);
  return [
    "You are on the close path for this PR.",
    `Target PR: ${prRef(pr)}`,
    "Write the exact comment to post. Do not post it yourself; the flow runtime will do that after this step.",
    "Use these exact headings in this order: `## Triage result`, `### Quick read`, `### Intent`, `### Why`, `### Codex review`, `### CI/CD`, `### Recommendation`.",
    "For this close path, the comment must make these top-line outcomes explicit:",
    "- `Solves the right problem: 🛑 Localized, bad, or unclear fix`",
    "- `Close PR: 🛑 Yes`",
    "- `Recommendation: 🏁 close PR`",
    "Use the current run state below as the source of truth:",
    JSON.stringify(summary, null, 2),
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "close_pr",',
      '  "summary": "short explanation",',
      '  "comment_format_followed": true | false,',
      '  "comment": "markdown comment to post"',
      "}",
    ]),
  ].join("\n");
}

function promptCommentAndEscalate(pr, outputs) {
  const summary = finalCommentSummary(outputs);
  return [
    "You are on the human handoff path for this PR.",
    `Target PR: ${prRef(pr)}`,
    "Write the exact comment to post. Do not post it yourself; the flow runtime will do that after this step.",
    "Use these exact headings in this order: `## Triage result`, `### Quick read`, `### Intent`, `### Why`, `### Codex review`, `### CI/CD`, `### Recommendation`.",
    "For this human handoff path, the comment must make these top-line outcomes explicit:",
    "- `Human attention: ⚠️ Required`",
    "- `Recommendation: 🏁 escalate to a human`",
    "- `Human decision needed: <explicit next human action>` near the top of the comment",
    "If the final conflict gate is clean and CI is green or unrelated, make the human decision needed `ready for human landing decision`.",
    "If the blocker is a conflict that still needs human judgment or another earlier stop condition, say that plainly in `Human decision needed`.",
    "If the remaining blocker is workflow approval, say that plainly.",
    "Use the current run state below as the source of truth:",
    JSON.stringify(summary, null, 2),
    ...exactJsonResponse([
      "Return exactly one JSON object with this shape:",
      "{",
      '  "route": "escalate_to_human",',
      '  "summary": "short explanation",',
      '  "human_decision_needed": "short explanation",',
      '  "comment_format_followed": true | false,',
      '  "comment": "markdown comment to post"',
      "}",
    ]),
  ].join("\n");
}

function exactJsonResponse(shapeLines: string[]) {
  return [
    "Return exactly one JSON object and nothing else.",
    "The first character of your response must be `{` and the last character must be `}`.",
    "Do not include commentary, progress updates, markdown fences, or any text before or after the JSON.",
    ...shapeLines,
  ];
}

function loadPullRequestInput(input) {
  const repo = String(input?.repo ?? "").trim();
  const prNumber = Number(input?.prNumber);

  if (!repo) {
    throw new Error('Flow input must include a non-empty "repo" string');
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('Flow input must include a positive integer "prNumber"');
  }

  return {
    repo,
    prNumber,
    prUrl: `https://github.com/${repo}/pull/${prNumber}`,
  };
}

function loadPrOutput(outputs) {
  return outputs.load_pr;
}

function prepared(outputs) {
  return outputs.prepare_workspace;
}

function prRef(pr) {
  return `${pr.repo}#${pr.prNumber} (${pr.prUrl})`;
}

function finalCommentSummary(outputs) {
  return {
    intent: outputs.extract_intent ?? null,
    solution: outputs.judge_solution ?? null,
    initialConflict:
      outputs.check_initial_conflicts ??
      outputs.judge_initial_conflicts ??
      outputs.resolve_initial_conflicts ??
      null,
    validationPath: outputs.bug_or_feature ?? null,
    validation: outputs.reproduce_bug_and_test_fix ?? outputs.test_feature_directly ?? null,
    refactor: outputs.judge_refactor ?? null,
    review: outputs.review_loop ?? null,
    ci: outputs.fix_ci_failures ?? null,
    finalConflict:
      outputs.check_final_conflicts ??
      outputs.judge_final_conflicts ??
      outputs.resolve_final_conflicts ??
      null,
  };
}

async function ensureProjectDependencies(workdir) {
  const packageJson = path.join(workdir, "package.json");
  const lockfile = path.join(workdir, "pnpm-lock.yaml");
  const nodeModules = path.join(workdir, "node_modules");

  if (!(await exists(packageJson)) || !(await exists(lockfile)) || (await exists(nodeModules))) {
    return;
  }

  await runCommand("pnpm", ["install", "--frozen-lockfile"], {
    cwd: workdir,
    timeoutMs: 20 * 60_000,
  });
}

function buildTargetedTestPlan(changedFiles) {
  const changedTestFiles = changedFiles
    .map((file) => String(file.filename ?? ""))
    .filter((filename) => /^test\/.+\.test\.ts$/.test(filename));

  if (changedTestFiles.length === 0) {
    return {
      commands: [],
    };
  }

  return {
    commands: [
      "pnpm run build:test",
      `node --test ${changedTestFiles.map((file) => `dist-test/${file.replace(/\.ts$/, ".js")}`).join(" ")}`,
    ],
  };
}

async function runValidationPlan(workdir, commands, options = {}) {
  const results = [];
  for (const command of commands) {
    const result = await runShellLine(command, {
      cwd: workdir,
      allowFailure: options.allowFailure === true,
      timeoutMs: 20 * 60_000,
    });
    results.push(result);
    if (!result.ok && options.allowFailure !== true) {
      return {
        ok: false,
        results,
      };
    }
    if (!result.ok && options.allowFailure === true) {
      return {
        ok: false,
        results,
      };
    }
  }

  return {
    ok: true,
    results,
  };
}

async function ghApiJson(endpoint) {
  const result = await runCommand("gh", ["api", endpoint]);
  return JSON.parse(result.stdout);
}

async function ghPrView(repo, prNumber, fields) {
  const result = await runCommand("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    fields.join(","),
  ]);
  return JSON.parse(result.stdout);
}

function normalizeGitHubReview(review) {
  return {
    id: review?.id ?? null,
    user: review?.user?.login ?? null,
    state: review?.state ?? null,
    body: limitText(typeof review?.body === "string" ? review.body : "", 1_500),
    submitted_at: review?.submitted_at ?? null,
    commit_id: review?.commit_id ?? null,
    html_url: review?.html_url ?? null,
  };
}

function normalizeGitHubReviewComment(comment) {
  return {
    id: comment?.id ?? null,
    user: comment?.user?.login ?? null,
    path: comment?.path ?? null,
    line: comment?.line ?? comment?.original_line ?? null,
    side: comment?.side ?? null,
    body: limitText(typeof comment?.body === "string" ? comment.body : "", 1_500),
    commit_id: comment?.commit_id ?? null,
    html_url: comment?.html_url ?? null,
  };
}

function normalizeGitHubIssueComment(comment) {
  return {
    id: comment?.id ?? null,
    user: comment?.user?.login ?? null,
    body: limitText(typeof comment?.body === "string" ? comment.body : "", 1_500),
    created_at: comment?.created_at ?? null,
    updated_at: comment?.updated_at ?? null,
    html_url: comment?.html_url ?? null,
  };
}

function extractLinkedIssueNumber(body) {
  const match = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function isTestFile(filename) {
  return /(^|\/)(test|tests|__tests__)\/|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(filename);
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function cleanupMergeState(workdir) {
  await runCommand("git", ["-C", workdir, "merge", "--abort"], {
    allowFailure: true,
  });
  await runCommand("git", ["-C", workdir, "reset", "--hard", "HEAD"], {
    allowFailure: true,
  });
}

function trimTextTail(text, maxChars) {
  const value = String(text ?? "").trim();
  if (!value || value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function limitText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function runShellLine(command, options = {}) {
  return await runCommand("zsh", ["-lc", command], options);
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timeoutId;

  if (options.timeoutMs) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
  }

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
      });
    });
  });

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  const ok = !timedOut && exit.exitCode === 0;
  if (!ok && options.allowFailure !== true) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `exitCode: ${String(exit.exitCode)}`,
        timedOut ? "timedOut: true" : null,
        stdout ? `stdout:\n${stdout}` : null,
        stderr ? `stderr:\n${stderr}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    ok,
    command,
    args,
    stdout,
    stderr,
    exitCode: exit.exitCode,
    signal: exit.signal,
    timedOut,
  };
}
