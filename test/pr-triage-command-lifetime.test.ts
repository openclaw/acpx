import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { FlowShellExecution, FlowShellResult } from "../src/flows/types.js";

type Context = {
  signal: AbortSignal;
  runShell: (execution: FlowShellExecution) => Promise<FlowShellResult>;
};
type CommandResult = Pick<
  FlowShellResult,
  "stdout" | "stderr" | "exitCode" | "signal" | "timedOut"
> & {
  command: string;
  args: string[];
  ok: boolean;
};
type Pr = { flowDir: string; workdir: string; repo: string; prNumber: number; baseRef: string };
type Helpers = {
  postClosePr: (context: Context, pr: Pr, comment: { comment: string }) => Promise<unknown>;
  cleanupMergeState: (context: Context, workdir: string) => Promise<void>;
  collectConflictState: (
    context: Context,
    pr: Pr,
    options: { phase: string },
  ) => Promise<{
    conflict_status: string;
    route: string;
    conflicted_files: string[];
    merge_attempt_exit_code: number;
    merge_attempt_stdout: string;
    merge_attempt_stderr: string;
  }>;
  runCommand: (
    context: Context,
    command: string,
    args: string[],
    options?: {
      allowFailure?: boolean;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ) => Promise<CommandResult>;
};

// Exercise the actual example helpers without importing/running its complete flow or invoking gh/git.
async function loadHelpers(): Promise<Helpers> {
  const filename = path.join(process.cwd(), "examples/flows/pr-triage/pr-triage.flow.ts");
  const source = await fs.readFile(filename, "utf8");
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "postClosePr",
    "cleanupMergeState",
    "collectConflictState",
    "runCommand",
    "writeJson",
    "trimTextTail",
  ]);
  const functions = parsed.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text),
  );
  assert.equal(functions.length, names.size, "all real helper declarations must remain present");
  const javascript = ts.transpileModule(
    functions.map((statement) => statement.getText(parsed)).join("\n"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  const moduleSource = `import fs from 'node:fs/promises';\nimport path from 'node:path';\n${javascript}\nexport { ${[...names].join(",")} };`;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
  )) as Helpers;
}

function shellResult(overrides: Partial<FlowShellResult> = {}): FlowShellResult {
  return {
    command: "synthetic",
    args: [],
    cwd: "/synthetic",
    stdout: "",
    stderr: "",
    combinedOutput: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    ...overrides,
  };
}

function barrier<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const kind of ["comment", "abort"] as const) {
  test(`triage cancellation between ${kind} and its next command prevents that next dispatch`, async () => {
    const helpers = await loadHelpers();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-triage-cancel-"));
    const pr: Pr = {
      flowDir: root,
      workdir: root,
      repo: "synthetic/repo",
      prNumber: 1,
      baseRef: "main",
    };
    const controller = new AbortController();
    const entered = barrier<void>();
    const completed = barrier<FlowShellResult>();
    const commands: FlowShellExecution[] = [];
    const context: Context = {
      signal: controller.signal,
      runShell: async (execution) => {
        commands.push(execution);
        entered.release();
        return await completed.promise;
      },
    };
    const reason = new Error("synthetic enclosing attempt revoked");
    try {
      const pending =
        kind === "comment"
          ? helpers.postClosePr(context, pr, { comment: "Synthetic review result." })
          : helpers.cleanupMergeState(context, root);
      const rejected = assert.rejects(pending, (error: unknown) => error === reason);
      await entered.promise;
      controller.abort(reason);
      // The boundary must remain safe even if an already-admitted command finishes successfully.
      completed.release(shellResult());
      await rejected;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].command, kind === "comment" ? "gh" : "git");
      assert.deepEqual(
        commands[0].args?.slice(0, kind === "comment" ? 2 : 4),
        kind === "comment" ? ["pr", "comment"] : ["-C", root, "merge", "--abort"],
      );
    } finally {
      completed.release(shellResult());
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const timedOut of [false, true]) {
  test(`triage allowFailure preserves ${timedOut ? "command-timeout" : "nonzero"} diagnostics`, async () => {
    const helpers = await loadHelpers();
    const response = shellResult({
      stdout: "partial output",
      stderr: "diagnostic",
      timedOut,
      exitCode: timedOut ? null : 7,
      signal: timedOut ? "SIGKILL" : null,
    });
    const executions: FlowShellExecution[] = [];
    const context: Context = {
      signal: new AbortController().signal,
      runShell: async (execution) => {
        executions.push(execution);
        return response;
      },
    };
    const options = {
      allowFailure: true,
      cwd: "/synthetic",
      env: { SYNTHETIC: "yes" },
      timeoutMs: 42,
    };
    const result = await helpers.runCommand(context, "synthetic", ["argument"], options);
    assert.deepEqual(result, {
      ok: false,
      command: "synthetic",
      args: ["argument"],
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      signal: response.signal,
      timedOut,
    });
    assert.deepEqual(executions, [
      {
        command: "synthetic",
        args: ["argument"],
        cwd: options.cwd,
        env: options.env,
        timeoutMs: 42,
      },
    ]);
    await assert.rejects(
      helpers.runCommand(context, "synthetic", ["argument"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Command failed: synthetic argument/);
        assert.match(error.message, /partial output/);
        assert.match(error.message, /diagnostic/);
        assert.equal(error.message.includes("timedOut: true"), timedOut);
        return true;
      },
    );
  });
}

test("triage allowFailure never converts an enclosing cancellation into command diagnostics", async () => {
  const helpers = await loadHelpers();
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation");
  const context: Context = {
    signal: controller.signal,
    runShell: async () => {
      controller.abort(reason);
      return shellResult({ timedOut: true, exitCode: null, signal: "SIGKILL" });
    },
  };
  await assert.rejects(
    helpers.runCommand(context, "synthetic", [], { allowFailure: true }),
    (error: unknown) => error === reason,
  );
});

test("triage retains a failed trial merge and its conflict diagnostics for ACP judgment", async () => {
  const helpers = await loadHelpers();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-triage-conflicts-"));
  const commands: string[][] = [];
  const context: Context = {
    signal: new AbortController().signal,
    runShell: async (execution) => {
      assert.equal(execution.command, "git");
      const args = execution.args ?? [];
      commands.push(args.slice(2));
      if (args.includes("--abort")) {
        return shellResult({ exitCode: 128, stderr: "No merge to abort" });
      }
      if (args.includes("--no-commit")) {
        return shellResult({ exitCode: 1, stdout: "merge output", stderr: "merge conflict" });
      }
      if (args.includes("--diff-filter=U")) {
        return shellResult({ stdout: "src/conflicted.ts\n" });
      }
      return shellResult();
    },
  };
  try {
    const result = await helpers.collectConflictState(
      context,
      {
        flowDir: root,
        workdir: root,
        repo: "synthetic/repo",
        prNumber: 1,
        baseRef: "main",
      },
      { phase: "initial" },
    );
    assert.deepEqual(commands, [
      ["merge", "--abort"],
      ["reset", "--hard", "HEAD"],
      ["fetch", "origin", "main"],
      ["merge", "--no-commit", "--no-ff", "origin/main"],
      ["diff", "--name-only", "--diff-filter=U"],
    ]);
    assert.equal(result.conflict_status, "conflicts_detected");
    assert.equal(result.route, "judge_initial_conflicts");
    assert.deepEqual(result.conflicted_files, ["src/conflicted.ts"]);
    assert.equal(result.merge_attempt_exit_code, 1);
    assert.equal(result.merge_attempt_stdout, "merge output");
    assert.equal(result.merge_attempt_stderr, "merge conflict");
    const persisted = JSON.parse(
      await fs.readFile(path.join(root, "initial-conflict-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.conflict_status, result.conflict_status);
    assert.deepEqual(persisted.conflicted_files, result.conflicted_files);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
