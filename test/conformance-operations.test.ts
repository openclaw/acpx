import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCaseDefinition } from "../conformance/runner/schema.js";
import { parseReport, runRunner } from "./conformance-test-helpers.js";

const CASES = [
  "acp.v1.errors.permission_denied",
  "acp.v1.errors.permission_denied.write",
  "acp.v1.permissions.read.approved",
  "acp.v1.permissions.write.approved",
];
const SENTINEL = "Synthetic AcPx filesystem content\n";
const READ_CHECK = {
  type: "filesystem_operation",
  method: "read_text_file",
  session: "$session_id",
  path: "README.md",
  outcome: { type: "success", content_includes: "acpx" },
};

type Trace = {
  pid: number;
  direction?: string;
  raw?: string;
  effect?: string;
  content?: string;
};

async function withFixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-conformance-operations-"));
  try {
    await fs.writeFile(path.join(directory, "README.md"), SENTINEL);
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function peerCommand(directory: string, mode: string): string {
  return [
    process.execPath,
    fileURLToPath(new URL("./fixtures/conformance-operation-agent.js", import.meta.url)),
    mode,
    path.join(directory, "wire.ndjson"),
  ]
    .map((value) => JSON.stringify(value))
    .join(" ");
}

async function trace(directory: string): Promise<Trace[]> {
  return (await fs.readFile(path.join(directory, "wire.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Trace);
}

for (const [mode, passed] of [
  ["fake", 0],
  ["permission-only", 0],
  ["real", 4],
  ["wrong-session", 0],
  ["wrong-path", 0],
  ["wrong-content", 2],
] as const) {
  test(`filesystem cases require actual matching callbacks: ${mode}`, async () => {
    await withFixture(async (directory) => {
      const result = await runRunner([
        "--profile",
        "conformance/profiles/acpx-mock-v1.json",
        ...CASES.flatMap((id) => ["--case", id]),
        "--agent-command",
        peerCommand(directory, mode),
        "--cwd",
        directory,
        "--format",
        "json",
      ]);
      const report = parseReport(result.stdout);
      assert.equal(result.code, passed === 4 ? 0 : 1, result.stderr);
      assert.deepEqual(report.totals, { cases: 4, passed, failed: 4 - passed });
      for (const row of report.results.filter((row) => !row.passed)) {
        assert.match(row.error ?? "", /expected completed filesystem operation/);
      }
      assert.equal(await fs.readFile(path.join(directory, "README.md"), "utf8"), SENTINEL);
      const rows = await trace(directory);
      const messages = rows
        .filter((row) => row.raw)
        .map((row) => ({
          pid: row.pid,
          direction: row.direction,
          message: JSON.parse(row.raw!) as {
            id?: number;
            method?: string;
            result?: { content?: string };
            error?: { code: number };
          },
        }));
      const operations = messages.filter((row) => row.message.method?.startsWith("fs/"));
      if (mode === "fake" || mode === "permission-only") {
        assert.equal(operations.length, 0);
        assert.equal(
          messages.filter((row) => row.message.method === "session/request_permission").length,
          mode === "fake" ? 0 : 4,
        );
      }
      if (mode === "real") {
        assert.equal(operations.length, 4);
        const responses = operations.map(
          (request) =>
            messages.find(
              (row) =>
                row.pid === request.pid &&
                row.direction === "in" &&
                row.message.id === request.message.id &&
                row.message.method === undefined,
            )?.message,
        );
        assert.deepEqual(
          responses.map((response) => response?.error?.code),
          [-32001, -32001, undefined, undefined],
        );
        assert.equal(responses[2]?.result?.content, SENTINEL);
        assert.deepEqual(responses[3]?.result, {});
        assert.deepEqual(
          rows.filter((row) => row.effect).map((row) => [row.effect, row.content]),
          [
            ["README.md", SENTINEL],
            [".acpx-conformance-write.txt", "hello"],
          ],
        );
        await assert.rejects(fs.stat(path.join(directory, ".acpx-conformance-write.txt")), {
          code: "ENOENT",
        });
      }
    });
  });
}

test("bundled mock passes the four filesystem cases", async () => {
  await withFixture(async (directory) => {
    const result = await runRunner([
      "--profile",
      "conformance/profiles/acpx-mock-v1.json",
      ...CASES.flatMap((id) => ["--case", id]),
      "--agent-command",
      "node --import tsx test/mock-agent.ts",
      "--cwd",
      directory,
      "--format",
      "json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseReport(result.stdout).totals, { cases: 4, passed: 4, failed: 0 });
    assert.equal(await fs.readFile(path.join(directory, "README.md"), "utf8"), SENTINEL);
  });
});

async function runCustom(
  directory: string,
  mode: string,
  variants: Array<{ check: object; permission?: string }>,
) {
  const casesDir = path.join(directory, "cases");
  await fs.mkdir(casesDir);
  const ids = variants.map((_, i) => `operation.${i}`);
  for (const [i, variant] of variants.entries()) {
    await fs.writeFile(
      path.join(casesDir, `${i}.json`),
      JSON.stringify({
        id: ids[i],
        permission_mode: variant.permission ?? "approve-all",
        steps: [
          { action: "new_session", save_as: "session_id" },
          {
            action: "prompt",
            session: "$session_id",
            prompt: [{ type: "text", text: "read README.md" }],
          },
        ],
        checks: [variant.check],
      }),
    );
  }
  const profile = path.join(directory, "profile.json");
  await fs.writeFile(profile, JSON.stringify({ id: "operations", required_cases: ids }));
  return runRunner([
    "--profile",
    profile,
    "--cases-dir",
    casesDir,
    "--agent-command",
    peerCommand(directory, mode),
    "--cwd",
    directory,
    "--format",
    "json",
  ]);
}

test("filesystem assertion checks method, returned content and exact local outcome", async () => {
  await withFixture(async (directory) => {
    const result = await runCustom(directory, "real", [
      {
        check: {
          ...READ_CHECK,
          method: "write_text_file",
          content: "hello",
          outcome: { type: "success" },
        },
      },
      { check: { ...READ_CHECK, outcome: { type: "success", content_includes: "absent marker" } } },
      { check: { ...READ_CHECK, outcome: { type: "error", code: -32001 } } },
      { check: READ_CHECK, permission: "deny-all" },
      {
        check: { ...READ_CHECK, outcome: { type: "error", code: -32603 } },
        permission: "deny-all",
      },
      {
        check: { ...READ_CHECK, outcome: { type: "error", code: -32001 } },
        permission: "deny-all",
      },
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(
      parseReport(result.stdout).results.map((row) => row.passed),
      [false, false, false, false, false, true],
    );
  });
});

test("filesystem operation evidence is explicitly case-wide", async () => {
  await withFixture(async (directory) => {
    const result = await runCustom(directory, "preprompt", [{ check: READ_CHECK }]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
    const rows = (await trace(directory))
      .filter((row) => row.raw)
      .map((row) => JSON.parse(row.raw!) as { method?: string; result?: object });
    assert.ok(
      rows.findIndex((row) => row.method === "fs/read_text_file") <
        rows.findIndex((row) => row.method === "session/prompt"),
    );
  });
});

test("filesystem assertion rejects malformed or incompatible fields", () => {
  for (const check of [
    { ...READ_CHECK, method: "request_permission" },
    { ...READ_CHECK, content: "unexpected read content" },
    { ...READ_CHECK, method: "write_text_file", outcome: { type: "success" } },
    { ...READ_CHECK, method: "write_text_file", content: "hello" },
    { ...READ_CHECK, outcome: { type: "error", code: "-32001" } },
    { ...READ_CHECK, outcome: { type: "error" } },
    { ...READ_CHECK, outcome: { type: "error", code: -32001, content_includes: "x" } },
    { ...READ_CHECK, outcome: { type: "success", code: -32001 } },
    { ...READ_CHECK, from: "unimplemented prompt scope" },
  ]) {
    assert.throws(
      () => parseCaseDefinition({ id: "invalid", checks: [check] }, "case.json"),
      /Invalid conformance file/,
    );
  }
  assert.doesNotThrow(() => parseCaseDefinition({ id: "read", checks: [READ_CHECK] }, "case.json"));
  assert.doesNotThrow(() =>
    parseCaseDefinition(
      {
        id: "empty-write",
        checks: [
          { ...READ_CHECK, method: "write_text_file", content: "", outcome: { type: "success" } },
        ],
      },
      "case.json",
    ),
  );
});

test("unfinished filesystem callback cannot satisfy completed success", async () => {
  await withFixture(async (directory) => {
    const keys = [
      "NODE_OPTIONS",
      "ACPX_CONFORMANCE_HELD_TARGET",
      "ACPX_CONFORMANCE_HELD_MARKER",
      "ACPX_CONFORMANCE_HELD_NONCE",
    ] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const markerPath = path.join(directory, "held.json");
    const nonce = `held-${path.basename(directory)}`;
    try {
      const preload = fileURLToPath(
        new URL("./fixtures/conformance-held-read.js", import.meta.url),
      );
      process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`;
      process.env.ACPX_CONFORMANCE_HELD_TARGET = await fs.realpath(
        path.join(directory, "README.md"),
      );
      process.env.ACPX_CONFORMANCE_HELD_MARKER = markerPath;
      process.env.ACPX_CONFORMANCE_HELD_NONCE = nonce;
      const result = await runCustom(directory, "held-read", [
        { check: { ...READ_CHECK, outcome: { type: "success" } } },
      ]);
      assert.equal(result.code, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /timed out/);
      const report = parseReport(result.stdout);
      assert.deepEqual(report.totals, { cases: 1, passed: 0, failed: 1 });
      assert.match(report.results[0]?.error ?? "", /expected completed filesystem operation/);
      assert.doesNotMatch(report.results[0]?.error ?? "", /cleanup|retirement/i);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
        pid: number;
        nonce: string;
        target: string;
      };
      assert.equal(marker.nonce, nonce);
      assert.equal(marker.target, process.env.ACPX_CONFORMANCE_HELD_TARGET);
      const rows = await trace(directory);
      assert.ok(rows.every((row) => row.pid !== marker.pid));
      const messages = rows
        .filter((row) => row.raw)
        .map(
          (row) =>
            JSON.parse(row.raw!) as {
              method?: string;
              id?: number;
              result?: unknown;
              error?: unknown;
            },
        );
      const request = messages.find((row) => row.method === "fs/read_text_file");
      assert.ok(request);
      assert.equal(
        messages.some((row) => !row.method && row.id === request.id),
        false,
      );
      assert.equal(await fs.readFile(path.join(directory, "README.md"), "utf8"), SENTINEL);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
