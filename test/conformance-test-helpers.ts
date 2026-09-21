import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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

export const REPO_ROOT = resolveRepoRoot();
const RUNNER_PATH = path.join(REPO_ROOT, "conformance/runner/run.ts");

export function parseReport(stdout: string): RunReport {
  const trimmed = stdout.trim();
  assert.equal(trimmed.length > 0, true, "expected JSON report on stdout");
  return JSON.parse(trimmed) as RunReport;
}

export async function runRunner(
  args: string[],
  options: { timeoutMs?: number; home?: string } = {},
): Promise<RunnerResult> {
  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER_PATH, ...args], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(options.home === undefined ? {} : { HOME: options.home }),
        NODE_V8_COVERAGE: "",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=DEP0205`.trim(),
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
