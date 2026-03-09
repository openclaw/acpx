import fs from "node:fs";
import path from "node:path";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "./perf-metrics.js";

const PERF_METRICS_FILE_ENV = "ACPX_PERF_METRICS_FILE";

let installed = false;
let flushed = false;
let captureFilePath: string | undefined;
let captureRole = "cli";
let captureArgv: string[] = [];
let captureSequence = 0;

type CaptureReason = "checkpoint" | "exit" | "signal";

function shouldCapture(): boolean {
  return typeof captureFilePath === "string" && captureFilePath.trim().length > 0;
}

function buildPayload(reason: CaptureReason): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    role: captureRole,
    argv: captureArgv,
    cwd: process.cwd(),
    sequence: captureSequence,
    reason,
    metrics: getPerfMetricsSnapshot(),
  };
}

function writePerfMetricsCapture(reason: CaptureReason, resetAfterWrite: boolean): boolean {
  if (!shouldCapture()) {
    return false;
  }

  const payload = buildPayload(reason);
  const metrics = payload.metrics as {
    counters?: Record<string, number>;
    gauges?: Record<string, number>;
    timings?: Record<string, unknown>;
  };
  const hasData =
    Object.keys(metrics.counters ?? {}).length > 0 ||
    Object.keys(metrics.gauges ?? {}).length > 0 ||
    Object.keys(metrics.timings ?? {}).length > 0;
  if (!hasData) {
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(captureFilePath!), { recursive: true });
    fs.appendFileSync(captureFilePath!, `${JSON.stringify(payload)}\n`, "utf8");
    captureSequence += 1;
    if (resetAfterWrite) {
      resetPerfMetrics();
    }
    return true;
  } catch {
    // metrics capture is best-effort only
    return false;
  }
}

export function checkpointPerfMetricsCapture(): void {
  flushed = false;
  writePerfMetricsCapture("checkpoint", true);
}

export function flushPerfMetricsCapture(reason: CaptureReason = "exit"): void {
  if (flushed || !shouldCapture()) {
    return;
  }
  flushed = true;
  writePerfMetricsCapture(reason, false);
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
  captureSequence = 0;
  flushed = false;

  if (installed) {
    return;
  }
  installed = true;

  process.once("exit", () => {
    flushPerfMetricsCapture("exit");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      flushPerfMetricsCapture("signal");
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  }
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
