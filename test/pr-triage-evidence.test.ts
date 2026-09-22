// Actual helper bodies; only the managed command boundary is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { FlowShellExecution, FlowShellResult } from "../src/flows/types.js";

type Context = {
  signal: AbortSignal;
  runShell: (execution: FlowShellExecution) => Promise<FlowShellResult>;
};
type Pr = {
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  flowDir: string;
  workdir: string;
};
type Helpers = {
  collectCiState: (context: Context, pr: Pr) => Promise<{ ci_state_path: string }>;
  collectReviewState: (
    context: Context,
    pr: Pr,
  ) => Promise<{
    review_state_path: string;
    local_codex_review_ran: boolean;
    local_codex_review_exit_code: number | null;
    local_codex_review_available: boolean;
  }>;
};
type Row = Record<string, unknown>;
type ReviewState = {
  baseRef: string;
  mergeBase: string;
  githubReviews: Row[];
  githubReviewComments: Row[];
  githubIssueComments: Row[];
  localCodexReviewText: string;
  localCodexReviewStdout: string;
  localCodexReviewStderr: string;
  localCodexReviewAvailable: boolean;
  localCodexReviewExitCode: number | null;
  localCodexReviewTimedOut: boolean;
};

async function loadHelpers(): Promise<Helpers> {
  const filename = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");
  const source = await fs.readFile(filename, "utf8");
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const required = new Set([
    "collectCiState",
    "collectReviewState",
    "ghApiJson",
    "ghPrView",
    "runCommand",
    "writeJson",
    "trimTextTail",
    "limitText",
    "normalizeGitHubReview",
    "normalizeGitHubReviewComment",
    "normalizeGitHubIssueComment",
  ]);
  const functions = parsed.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      (required.has(statement.name.text) || statement.name.text === "ghApiList"),
  );
  for (const name of required) {
    assert.ok(
      functions.some(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      ),
      name,
    );
  }
  const javascript = ts.transpileModule(
    functions.map((statement) => statement.getText(parsed)).join("\n"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  const reviewText = pathToFileURL(
    path.join(process.cwd(), "examples/flows/pr-triage/review-text.js"),
  ).href;
  const moduleSource = `import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { selectLocalCodexReviewText } from ${JSON.stringify(reviewText)};\n${javascript}\nexport { collectCiState, collectReviewState };`;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
  )) as Helpers;
}

function result(stdout = "", overrides: Partial<FlowShellResult> = {}): FlowShellResult {
  return {
    command: "synthetic",
    args: [],
    cwd: "/synthetic",
    stdout,
    stderr: "",
    combinedOutput: stdout,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    ...overrides,
  };
}
async function fixture(run: (helpers: Helpers, pr: Pr) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-triage-evidence-"));
  try {
    await run(await loadHelpers(), {
      repo: "synthetic/repo",
      prNumber: 7,
      headSha: "prepared-head",
      baseRef: "main",
      flowDir: root,
      workdir: root,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
function reviewContext(pages: Row[][], local = result("Synthetic local review.")) {
  const calls: FlowShellExecution[] = [];
  const controller = new AbortController();
  const context: Context = {
    signal: controller.signal,
    runShell: async (execution) => {
      calls.push(execution);
      const args = execution.args ?? [];
      if (execution.command === "gh" && args[0] === "api") {
        const selected = args.includes("--paginate") && args.includes("--slurp") ? pages : pages[0];
        return result(JSON.stringify(selected));
      }
      if (execution.command === "git") {
        return result(args.includes("merge-base") ? "synthetic-merge-base\n" : "");
      }
      if (execution.command === "codex") {
        return local;
      }
      return assert.fail(`Unexpected managed command: ${execution.command}`);
    },
  };
  return { context, calls, controller };
}
async function readReview(pr: Pr): Promise<ReviewState> {
  return JSON.parse(
    await fs.readFile(path.join(pr.flowDir, "review-state.json"), "utf8"),
  ) as ReviewState;
}

test("CI evidence uses the current PR head, not its oldest commit or prepared head", async () => {
  await fixture(async (helpers, pr) => {
    const calls: FlowShellExecution[] = [];
    const checks = [{ name: "current-head-check", status: "QUEUED" }];
    const context: Context = {
      signal: new AbortController().signal,
      runShell: async (execution) => {
        calls.push(execution);
        const args = execution.args ?? [];
        assert.equal(execution.command, "gh");
        if (args[0] === "pr") {
          return result(
            JSON.stringify({
              headRefOid: "current-head",
              statusCheckRollup: checks,
              commits: [{ oid: "oldest-head" }, { oid: "current-head" }],
            }),
          );
        }
        assert.equal(args[0], "api");
        const query = new URL(`https://example.invalid/${args[1]}`);
        return result(
          JSON.stringify({
            workflow_runs: [{ id: 27, head_sha: query.searchParams.get("head_sha") }],
          }),
        );
      },
    };
    const output = await helpers.collectCiState(context, pr);
    const state = JSON.parse(await fs.readFile(output.ci_state_path, "utf8")) as Row;
    assert.deepEqual(state.workflowRuns, [{ id: 27, head_sha: "current-head" }]);
    assert.equal(state.headSha, "current-head");
    assert.deepEqual(state.statusCheckRollup, checks);
    assert.deepEqual(output, { ci_state_path: path.join(pr.flowDir, "ci-state.json") });
    const fields = calls[0].args?.at(-1)?.split(",");
    assert.ok(fields?.includes("headRefOid"));
    assert.equal(fields?.includes("commits"), false);
    assert.equal(calls[1].args?.includes("--paginate"), false);
  });
});

test("CI head fallback keeps the prepared head for omitted, null, and empty metadata", async () => {
  await fixture(async (helpers, pr) => {
    for (const headRefOid of [undefined, null, ""]) {
      const calls: FlowShellExecution[] = [];
      const context: Context = {
        signal: new AbortController().signal,
        runShell: async (execution) => {
          calls.push(execution);
          return result(
            JSON.stringify(
              execution.args?.[0] === "pr"
                ? { headRefOid, statusCheckRollup: [] }
                : { workflow_runs: [] },
            ),
          );
        },
      };
      const output = await helpers.collectCiState(context, pr);
      assert.match(calls[1].args?.[1] ?? "", /head_sha=prepared-head&/);
      const state = JSON.parse(await fs.readFile(output.ci_state_path, "utf8")) as Row;
      assert.deepEqual(state.statusCheckRollup, []);
      assert.deepEqual(state.workflowRuns, []);
    }
  });
});

test("review evidence preserves all pages of all three flat normalized lists", async () => {
  await fixture(async (helpers, pr) => {
    const old = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: "older feedback",
      commit_id: "old-head",
    }));
    const last = {
      id: 101,
      user: { login: "synthetic-reviewer" },
      state: "CHANGES_REQUESTED",
      body: "[P1] Current-head sentinel",
      commit_id: "current-head",
      path: "src/example.ts",
      line: 11,
      side: "RIGHT",
      submitted_at: "synthetic-time",
      created_at: "synthetic-time",
      updated_at: "synthetic-time",
      html_url: "https://example.invalid/review/101",
    };
    const { context, calls } = reviewContext([old, [last], []]);
    const output = await helpers.collectReviewState(context, pr);
    const state = await readReview(pr);
    for (const rows of [
      state.githubReviews,
      state.githubReviewComments,
      state.githubIssueComments,
    ]) {
      assert.deepEqual(
        rows.map((row) => row.id),
        Array.from({ length: 101 }, (_, index) => index + 1),
      );
      assert.equal(rows[100].body, last.body);
      assert.equal(rows[100].user, "synthetic-reviewer");
    }
    assert.deepEqual(state.githubReviews[100], {
      id: 101,
      user: "synthetic-reviewer",
      state: last.state,
      body: last.body,
      submitted_at: last.submitted_at,
      commit_id: last.commit_id,
      html_url: last.html_url,
    });
    assert.equal(state.githubReviewComments[100].path, last.path);
    assert.equal(state.githubReviewComments[100].line, 11);
    assert.equal(state.githubReviewComments[100].commit_id, last.commit_id);
    assert.equal(Object.hasOwn(state.githubIssueComments[100], "commit_id"), false);
    assert.equal(state.githubIssueComments[100].created_at, last.created_at);
    const apiCalls = calls.filter((call) => call.command === "gh");
    assert.deepEqual(
      apiCalls.map((call) => call.args?.[1]),
      [
        "repos/synthetic/repo/pulls/7/reviews?per_page=100",
        "repos/synthetic/repo/pulls/7/comments?per_page=100",
        "repos/synthetic/repo/issues/7/comments?per_page=100",
      ],
    );
    for (const call of apiCalls) {
      assert.ok(call.args?.includes("--paginate") && call.args.includes("--slurp"));
    }
    assert.equal(state.baseRef, "origin/main");
    assert.equal(state.mergeBase, "synthetic-merge-base");
    assert.equal(state.localCodexReviewText, "Synthetic local review.");
    assert.deepEqual(output, {
      review_state_path: path.join(pr.flowDir, "review-state.json"),
      local_codex_review_ran: true,
      local_codex_review_exit_code: 0,
      local_codex_review_available: true,
    });
  });
});

test("empty review pages and local-review failure retain the established projections", async () => {
  await fixture(async (helpers, pr) => {
    const { context } = reviewContext(
      [[]],
      result("Synthetic local review failed.", { exitCode: 7, stderr: "review diagnostic" }),
    );
    const output = await helpers.collectReviewState(context, pr);
    const state = await readReview(pr);
    assert.deepEqual(
      [state.githubReviews, state.githubReviewComments, state.githubIssueComments],
      [[], [], []],
    );
    assert.equal(state.localCodexReviewExitCode, 7);
    assert.equal(state.localCodexReviewTimedOut, false);
    assert.equal(state.localCodexReviewText, "Synthetic local review failed.");
    assert.equal(state.localCodexReviewStderr, "review diagnostic");
    assert.equal(output.local_codex_review_exit_code, 7);
    assert.equal(output.local_codex_review_available, true);
  });
});

test("malformed review pages do not overwrite prior evidence", async () => {
  await fixture(async (helpers, pr) => {
    const file = path.join(pr.flowDir, "review-state.json");
    const prior = '{"prior":"unchanged"}\n';
    await fs.writeFile(file, prior, "utf8");
    const calls: FlowShellExecution[] = [];
    const context: Context = {
      signal: new AbortController().signal,
      runShell: async (execution) => {
        calls.push(execution);
        return result("[[],{}]");
      },
    };
    await assert.rejects(helpers.collectReviewState(context, pr), /Expected array pages/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "gh");
    assert.equal(await fs.readFile(file, "utf8"), prior);
  });
});

for (const mode of ["page-failure", "invalid-json", "cancelled"] as const) {
  test(`review ${mode} does not publish partial evidence or dispatch later work`, async () => {
    await fixture(async (helpers, pr) => {
      const file = path.join(pr.flowDir, "review-state.json"),
        prior = '{"prior":"unchanged"}\n';
      await fs.writeFile(file, prior, "utf8");
      const calls: FlowShellExecution[] = [],
        controller = new AbortController();
      const reason = new Error("synthetic enclosing attempt revoked");
      const context: Context = {
        signal: controller.signal,
        runShell: async (execution) => {
          calls.push(execution);
          if (mode === "cancelled") {
            controller.abort(reason);
          }
          return mode === "page-failure"
            ? result('[{"id":1}]', { exitCode: 1, stderr: "synthetic page two failure" })
            : result(mode === "invalid-json" ? "{unfinished" : "[[]]");
        },
      };
      await assert.rejects(helpers.collectReviewState(context, pr), (error: unknown) => {
        if (mode === "cancelled") {
          assert.equal(error, reason);
        } else if (mode === "invalid-json") {
          assert.ok(error instanceof SyntaxError);
        } else {
          assert.match(String(error), /synthetic page two failure/);
        }
        return true;
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "gh");
      assert.equal(await fs.readFile(file, "utf8"), prior);
    });
  });
}
