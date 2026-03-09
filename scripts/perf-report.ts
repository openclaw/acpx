import fs from "node:fs/promises";
import path from "node:path";

type PerfMetricSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

type GaugeSummary = {
  last: number;
  max: number;
};

type PerfRecord = {
  timestamp?: string;
  pid?: number;
  role?: string;
  argv?: string[];
  reason?: string;
  metrics?: {
    counters?: Record<string, number>;
    timings?: Record<string, PerfMetricSummary>;
    gauges?: Record<string, number>;
  };
};

type AggregateSummary = {
  counters: Map<string, number>;
  timings: Map<string, PerfMetricSummary>;
  gauges: Map<string, GaugeSummary>;
};

function usage(): never {
  throw new Error("Usage: pnpm exec tsx scripts/perf-report.ts <metrics.ndjson>");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function createAggregateSummary(): AggregateSummary {
  return {
    counters: new Map<string, number>(),
    timings: new Map<string, PerfMetricSummary>(),
    gauges: new Map<string, GaugeSummary>(),
  };
}

function addRecordToSummary(summary: AggregateSummary, record: PerfRecord): void {
  for (const [name, value] of Object.entries(record.metrics?.counters ?? {})) {
    summary.counters.set(name, (summary.counters.get(name) ?? 0) + value);
  }

  for (const [name, value] of Object.entries(record.metrics?.timings ?? {})) {
    const existing = summary.timings.get(name) ?? {
      count: 0,
      totalMs: 0,
      maxMs: 0,
    };
    existing.count += value.count;
    existing.totalMs += value.totalMs;
    existing.maxMs = Math.max(existing.maxMs, value.maxMs);
    summary.timings.set(name, existing);
  }

  for (const [name, value] of Object.entries(record.metrics?.gauges ?? {})) {
    const existing = summary.gauges.get(name) ?? {
      last: value,
      max: value,
    };
    existing.last = value;
    existing.max = Math.max(existing.max, value);
    summary.gauges.set(name, existing);
  }
}

function finalizeSummary(summary: AggregateSummary): {
  counters: Record<string, number>;
  gauges: Record<string, { last: number; max: number }>;
  timings: Array<{
    name: string;
    count: number;
    totalMs: number;
    avgMs: number;
    maxMs: number;
  }>;
} {
  const timings = [...summary.timings.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      totalMs: round(value.totalMs),
      avgMs: round(value.totalMs / Math.max(1, value.count)),
      maxMs: round(value.maxMs),
    }))
    .toSorted((a, b) => b.totalMs - a.totalMs);

  const gauges = Object.fromEntries(
    [...summary.gauges.entries()].map(([name, value]) => [
      name,
      {
        last: round(value.last),
        max: round(value.max),
      },
    ]),
  );

  return {
    counters: Object.fromEntries(summary.counters.entries()),
    gauges,
    timings,
  };
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
  }

  const payload = await fs.readFile(path.resolve(filePath), "utf8");
  const lines = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records: PerfRecord[] = [];
  const droppedLines: Array<{ line: number; error: string }> = [];

  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as PerfRecord);
    } catch (error) {
      droppedLines.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const roleCounts = new Map<string, number>();
  const overallSummary = createAggregateSummary();
  const roleSummaries = new Map<string, AggregateSummary>();

  for (const record of records) {
    const role = record.role ?? "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    addRecordToSummary(overallSummary, record);
    let roleSummary = roleSummaries.get(role);
    if (!roleSummary) {
      roleSummary = createAggregateSummary();
      roleSummaries.set(role, roleSummary);
    }
    addRecordToSummary(roleSummary, record);
  }
  const byRole = Object.fromEntries(
    [...roleSummaries.entries()].map(([role, summary]) => [role, finalizeSummary(summary)]),
  );
  const overall = finalizeSummary(overallSummary);

  console.log(
    JSON.stringify(
      {
        droppedLines: droppedLines.length,
        droppedLineExamples: droppedLines.slice(0, 5),
        records: records.length,
        roles: Object.fromEntries(roleCounts.entries()),
        counters: overall.counters,
        gauges: overall.gauges,
        timings: overall.timings,
        byRole,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
