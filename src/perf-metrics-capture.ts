import fs from "node:fs";
import path from "node:path";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "./perf-metrics.js";

const PERF_METRICS_FILE_ENV = "ACPX_PERF_METRICS_FILE";

let installed = false;
let flushed = false;
let captureFilePath: string | undefined;
let captureRole = "cli";
let captureArgv: string[] = [];

function shouldCapture(): boolean {
  return typeof captureFilePath === "string" && captureFilePath.trim().length > 0;
}

function buildPayload(): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    role: captureRole,
    argv: captureArgv,
    cwd: process.cwd(),
    metrics: getPerfMetricsSnapshot(),
  };
}

export function flushPerfMetricsCapture(): void {
  if (flushed || !shouldCapture()) {
    return;
  }
  flushed = true;

  try {
    fs.mkdirSync(path.dirname(captureFilePath!), { recursive: true });
    fs.appendFileSync(captureFilePath!, `${JSON.stringify(buildPayload())}\n`, "utf8");
  } catch {
    // metrics capture is best-effort only
  }
}

export function installPerfMetricsCapture(
  options: {
    argv?: string[];
    role?: string;
    filePath?: string;
  } = {},
): void {
  captureFilePath = options.filePath ?? process.env[PERF_METRICS_FILE_ENV];
  if (!shouldCapture()) {
    return;
  }

  resetPerfMetrics();
  captureRole = options.role ?? captureRole;
  captureArgv = options.argv ?? [];
  flushed = false;

  if (installed) {
    return;
  }
  installed = true;

  process.once("exit", () => {
    flushPerfMetricsCapture();
  });
  process.once("SIGINT", () => {
    flushPerfMetricsCapture();
  });
  process.once("SIGTERM", () => {
    flushPerfMetricsCapture();
  });
}

export function perfMetricsCaptureFileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[PERF_METRICS_FILE_ENV];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}
