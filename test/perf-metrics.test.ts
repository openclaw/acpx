import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPerfMetric,
  getPerfMetricsSnapshot,
  incrementPerfCounter,
  measurePerf,
  recordPerfDuration,
  resetPerfMetrics,
  setPerfGauge,
  startPerfTimer,
} from "../src/perf-metrics.js";

test.beforeEach(() => {
  resetPerfMetrics();
});

test("incrementPerfCounter creates a new counter starting at 1", () => {
  incrementPerfCounter("test.new_counter");
  const snapshot = getPerfMetricsSnapshot();
  assert.equal(snapshot.counters["test.new_counter"], 1);
});

test("incrementPerfCounter accumulates multiple increments", () => {
  incrementPerfCounter("test.multi");
  incrementPerfCounter("test.multi");
  incrementPerfCounter("test.multi");
  const snapshot = getPerfMetricsSnapshot();
  assert.equal(snapshot.counters["test.multi"], 3);
});

test("incrementPerfCounter accepts a custom delta", () => {
  incrementPerfCounter("test.delta", 5);
  incrementPerfCounter("test.delta", 3);
  const snapshot = getPerfMetricsSnapshot();
  assert.equal(snapshot.counters["test.delta"], 8);
});

test("setPerfGauge sets and overwrites gauge values", () => {
  setPerfGauge("test.gauge", 42);
  assert.equal(getPerfMetricsSnapshot().gauges["test.gauge"], 42);

  setPerfGauge("test.gauge", 99);
  assert.equal(getPerfMetricsSnapshot().gauges["test.gauge"], 99);
});

test("recordPerfDuration tracks count, totalMs, and maxMs", () => {
  recordPerfDuration("test.timing", 10);
  recordPerfDuration("test.timing", 50);
  recordPerfDuration("test.timing", 30);

  const timing = getPerfMetricsSnapshot().timings["test.timing"];
  assert.equal(timing.count, 3);
  assert.equal(timing.totalMs, 90);
  assert.equal(timing.maxMs, 50);
});

test("recordPerfDuration rounds values to 3 decimal places in snapshot", () => {
  recordPerfDuration("test.precision", 1.23456789);
  const timing = getPerfMetricsSnapshot().timings["test.precision"];
  assert.equal(timing.totalMs, 1.235);
  assert.equal(timing.maxMs, 1.235);
});

test("measurePerf records duration of an async function", async () => {
  const result = await measurePerf("test.measure", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "done";
  });

  assert.equal(result, "done");
  const timing = getPerfMetricsSnapshot().timings["test.measure"];
  assert.equal(timing.count, 1);
  assert.ok(timing.totalMs >= 10, `expected >= 10ms, got ${timing.totalMs}ms`);
});

test("measurePerf records duration even when the function throws", async () => {
  await assert.rejects(async () => {
    await measurePerf("test.measure_throw", async () => {
      throw new Error("boom");
    });
  });

  const timing = getPerfMetricsSnapshot().timings["test.measure_throw"];
  assert.equal(timing.count, 1);
  assert.ok(timing.totalMs >= 0);
});

test("startPerfTimer returns a stop function that records elapsed time", () => {
  const stop = startPerfTimer("test.timer");
  const elapsed = stop();

  assert.equal(typeof elapsed, "number");
  assert.ok(elapsed >= 0);

  const timing = getPerfMetricsSnapshot().timings["test.timer"];
  assert.equal(timing.count, 1);
});

test("getPerfMetricsSnapshot returns empty maps after reset", () => {
  incrementPerfCounter("test.c");
  setPerfGauge("test.g", 1);
  recordPerfDuration("test.t", 5);

  resetPerfMetrics();
  const snapshot = getPerfMetricsSnapshot();
  assert.deepEqual(snapshot.counters, {});
  assert.deepEqual(snapshot.gauges, {});
  assert.deepEqual(snapshot.timings, {});
});

test("getPerfMetricsSnapshot isolates counters, gauges, and timings", () => {
  incrementPerfCounter("c1");
  incrementPerfCounter("c2", 7);
  setPerfGauge("g1", 100);
  recordPerfDuration("t1", 25);

  const snapshot = getPerfMetricsSnapshot();
  assert.equal(snapshot.counters["c1"], 1);
  assert.equal(snapshot.counters["c2"], 7);
  assert.equal(snapshot.gauges["g1"], 100);
  assert.equal(snapshot.timings["t1"].count, 1);
  assert.equal(snapshot.timings["t1"].totalMs, 25);
  assert.equal(snapshot.timings["t1"].maxMs, 25);
});

test("formatPerfMetric formats name and duration with 3 decimal places", () => {
  assert.equal(formatPerfMetric("session.load", 123.456789), "session.load=123.457ms");
  assert.equal(formatPerfMetric("fast.op", 0.1), "fast.op=0.1ms");
  assert.equal(formatPerfMetric("exact", 5), "exact=5ms");
});
