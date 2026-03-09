import fs from "node:fs/promises";
import path from "node:path";

type PerfMetricSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

type PerfRecord = {
  timestamp?: string;
  pid?: number;
  role?: string;
  argv?: string[];
  metrics?: {
    counters?: Record<string, number>;
    timings?: Record<string, PerfMetricSummary>;
    gauges?: Record<string, number>;
  };
};

function usage(): never {
  throw new Error("Usage: pnpm exec tsx scripts/perf-report.ts <metrics.ndjson>");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
  }

  const payload = await fs.readFile(path.resolve(filePath), "utf8");
  const records = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PerfRecord);

  const timingTotals = new Map<string, PerfMetricSummary>();
  const counterTotals = new Map<string, number>();
  const roleCounts = new Map<string, number>();

  for (const record of records) {
    roleCounts.set(record.role ?? "unknown", (roleCounts.get(record.role ?? "unknown") ?? 0) + 1);

    for (const [name, value] of Object.entries(record.metrics?.counters ?? {})) {
      counterTotals.set(name, (counterTotals.get(name) ?? 0) + value);
    }

    for (const [name, value] of Object.entries(record.metrics?.timings ?? {})) {
      const existing = timingTotals.get(name) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
      };
      existing.count += value.count;
      existing.totalMs += value.totalMs;
      existing.maxMs = Math.max(existing.maxMs, value.maxMs);
      timingTotals.set(name, existing);
    }
  }

  const timingRows = [...timingTotals.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      totalMs: round(value.totalMs),
      avgMs: round(value.totalMs / Math.max(1, value.count)),
      maxMs: round(value.maxMs),
    }))
    .toSorted((a, b) => b.totalMs - a.totalMs);

  console.log(
    JSON.stringify(
      {
        records: records.length,
        roles: Object.fromEntries(roleCounts.entries()),
        counters: Object.fromEntries(counterTotals.entries()),
        timings: timingRows,
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
