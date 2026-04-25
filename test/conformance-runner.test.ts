import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type RunnerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type RunReport = {
  totals: {
    cases: number;
    passed: number;
    failed: number;
  };
  results: Array<{
    id: string;
    passed: boolean;
    error?: string;
  }>;
};

const REPO_ROOT = resolveRepoRoot();
const RUNNER_PATH = path.join(REPO_ROOT, "conformance/runner/run.ts");
const MOCK_AGENT_COMMAND = "node --import tsx test/mock-agent.ts";

test("runner reports initialize failures as failed cases and still writes a report", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const reportPath = path.join(tmp, "report.json");
    const result = await runRunner(
      [
        "--case",
        "acp.v1.initialize.handshake",
        "--agent-command",
        'node -e "setTimeout(() => {}, 20000)"',
        "--format",
        "json",
        "--report",
        reportPath,
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr.trim(), "");

    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 0,
      failed: 1,
    });
    assert.equal(report.results[0]?.id, "acp.v1.initialize.handshake");
    assert.equal(report.results[0]?.passed, false);
    assert.match(report.results[0]?.error ?? "", /initialize timed out/i);

    const savedReport = parseReport(await fs.readFile(reportPath, "utf8"));
    assert.deepEqual(savedReport.totals, report.totals);
    assert.equal(savedReport.results[0]?.passed, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner reports missing adapter commands as failed initialize cases", async () => {
  const result = await runRunner(
    [
      "--case",
      "acp.v1.initialize.handshake",
      "--agent-command",
      "definitely-not-a-real-command",
      "--format",
      "json",
    ],
    { timeoutMs: 20_000 },
  );

  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stderr.trim(), "");

  const report = parseReport(result.stdout);
  assert.deepEqual(report.totals, {
    cases: 1,
    passed: 0,
    failed: 1,
  });
  assert.equal(report.results[0]?.id, "acp.v1.initialize.handshake");
  assert.equal(report.results[0]?.passed, false);
  assert.match(report.results[0]?.error ?? "", /failed to spawn agent process/i);
});

test("runner resolves relative file reads within session cwd without changing adapter command cwd", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const token = "TOKEN_FROM_SESSION_CWD";
    await fs.writeFile(path.join(tmp, "README.md"), `${token}\n`, "utf8");

    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.read.session_cwd",
        title: "Read resolves from session cwd",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "read README.md" }],
            save_as: "read_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "read_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: token,
          },
        ],
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--cwd",
        tmp,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner rejects reads outside the session cwd root", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.read.outside_root",
        title: "Read outside session cwd root is rejected",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "read /etc/hosts" }],
            save_as: "read_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "read_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: "outside session cwd root",
          },
        ],
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--cwd",
        tmp,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runner observes late post-success tool updates after settle timeout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-runner-"));
  try {
    const { profilePath, casesDir } = await writeFixture(tmp, [
      {
        id: "custom.prompt.post_success_drain",
        title: "Late post-success tool updates remain observable",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "late-tool 40 follow-up" }],
            save_as: "prompt_result",
          },
        ],
        checks: [
          {
            type: "saved_stop_reason_in",
            key: "prompt_result",
            values: ["end_turn"],
          },
          {
            type: "updates_text_includes",
            text: "writing now",
          },
          {
            type: "updates_session_update_includes",
            values: ["tool_call", "tool_call_update"],
          },
        ],
        timeouts: {
          settle_timeout_ms: 160,
        },
      },
    ]);

    const result = await runRunner(
      [
        "--profile",
        profilePath,
        "--cases-dir",
        casesDir,
        "--agent-command",
        MOCK_AGENT_COMMAND,
        "--format",
        "json",
      ],
      { timeoutMs: 20_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.deepEqual(report.totals, {
      cases: 1,
      passed: 1,
      failed: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function writeFixture(
  rootDir: string,
  cases: Array<Record<string, unknown>>,
): Promise<{ profilePath: string; casesDir: string }> {
  const casesDir = path.join(rootDir, "cases");
  const profilesDir = path.join(rootDir, "profiles");
  await fs.mkdir(casesDir, { recursive: true });
  await fs.mkdir(profilesDir, { recursive: true });

  const requiredCases: string[] = [];

  for (const [index, definition] of cases.entries()) {
    const id = definition.id;
    assert.equal(typeof id, "string");
    requiredCases.push(id as string);

    const fileName = `${String(index + 1).padStart(3, "0")}-${id}.json`;
    await fs.writeFile(
      path.join(casesDir, fileName),
      `${JSON.stringify(definition, null, 2)}\n`,
      "utf8",
    );
  }

  const profilePath = path.join(profilesDir, "profile.json");
  await fs.writeFile(
    profilePath,
    `${JSON.stringify(
      {
        id: "custom-profile",
        required_cases: requiredCases,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { profilePath, casesDir };
}

function parseReport(stdout: string): RunReport {
  const trimmed = stdout.trim();
  assert.equal(trimmed.length > 0, true, "expected JSON report on stdout");
  return JSON.parse(trimmed) as RunReport;
}

async function runRunner(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<RunnerResult> {
  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER_PATH, ...args], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_V8_COVERAGE: "",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.end();

    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        stderr += `[test] timed out after ${timeoutMs}ms\n`;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function resolveRepoRoot(): string {
  const candidates = [fileURLToPath(new URL("../..", import.meta.url)), process.cwd()];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "conformance/runner/run.ts"))) {
      return candidate;
    }
  }
  throw new Error("Failed to resolve repository root for conformance runner tests");
}
