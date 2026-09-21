import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runRunner, parseReport } from "./conformance-test-helpers.js";

type CaseFile = { name: string; value: unknown } | { name: string; raw: string };
type CaseWire = {
  pid: number;
  direction: "in" | "out";
  raw: string;
  message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { code: number; message: string };
  };
};

async function writeInput(
  directory: string,
  profile: unknown,
  files: CaseFile[],
): Promise<{ args: string[]; bootPath: string; tracePath: string; reportPath: string }> {
  const casesDir = path.join(directory, "cases");
  const profilePath = path.join(directory, "profile.json");
  const bootPath = path.join(directory, "boot.jsonl");
  const tracePath = path.join(directory, "wire.jsonl");
  const reportPath = path.join(directory, "report.json");
  await fs.mkdir(casesDir);
  await fs.writeFile(profilePath, JSON.stringify(profile));
  for (const file of files) {
    const raw = "raw" in file ? file.raw : JSON.stringify(file.value);
    assert.equal(typeof raw, "string");
    await fs.writeFile(path.join(casesDir, file.name), raw);
  }
  const peer = fileURLToPath(
    new URL("./fixtures/conformance-case-validation-agent.js", import.meta.url),
  );
  const command = [process.execPath, peer, bootPath, tracePath]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  return {
    bootPath,
    tracePath,
    reportPath,
    args: [
      "--profile",
      profilePath,
      "--cases-dir",
      casesDir,
      "--cwd",
      directory,
      "--agent-command",
      command,
      "--format",
      "json",
      "--report",
      reportPath,
    ],
  };
}

async function readCaseWire(tracePath: string): Promise<CaseWire[]> {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const entry = JSON.parse(line) as Omit<CaseWire, "message">;
      return {
        pid: entry.pid,
        direction: entry.direction,
        raw: entry.raw,
        message: JSON.parse(entry.raw) as CaseWire["message"],
      };
    });
}

function assertPeerError(trace: CaseWire[], request: CaseWire): void {
  const responses = trace.filter(
    (entry) =>
      entry.pid === request.pid &&
      entry.direction === "out" &&
      entry.message.id === request.message.id &&
      !entry.message.method,
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.message.error?.code, -32602);
  assert.equal(Object.hasOwn(responses[0]?.message ?? {}, "result"), false);
}

const STEP_PATH = /steps(?:\[0\]|\.0).*action/s;
const CHECK_PATH = /checks(?:\[0\]|\.0).*type/s;
const invalidCases: Array<{ label: string; value?: unknown; raw?: string; diagnostic: RegExp[] }> =
  [
    {
      label: "unknown action",
      value: { id: "bad", steps: [{ action: "not_a_real_step" }] },
      diagnostic: [STEP_PATH, /not_a_real_step/],
    },
    {
      label: "unknown check",
      value: { id: "bad", checks: [{ type: "not_a_real_check" }] },
      diagnostic: [CHECK_PATH, /not_a_real_check/],
    },
    { label: "misspelled checks", value: { id: "bad", cheks: [] }, diagnostic: [/cheks/] },
    {
      label: "misspelled expectation",
      value: { id: "bad", steps: [{ action: "new_session", expect_eror: {} }] },
      diagnostic: [/expect_eror/],
    },
    { label: "null case", value: null, diagnostic: [/case|object/i] },
    { label: "array case", value: [], diagnostic: [/case|object/i] },
    { label: "object steps", value: { id: "bad", steps: {} }, diagnostic: [/steps/] },
    { label: "null check", value: { id: "bad", checks: [null] }, diagnostic: [/checks/] },
    { label: "missing action", value: { id: "bad", steps: [{}] }, diagnostic: [/steps/, /action/] },
    {
      label: "string sleep",
      value: { id: "bad", steps: [{ action: "sleep", ms: "1" }] },
      diagnostic: [/ms/],
    },
    {
      label: "missing session key",
      value: { id: "bad", steps: [{ action: "prompt", prompt: [] }] },
      diagnostic: [/session/],
    },
    {
      label: "nonarray prompt",
      value: { id: "bad", steps: [{ action: "prompt", session: null, prompt: {} }] },
      diagnostic: [/prompt/],
    },
    {
      label: "missing background save",
      value: { id: "bad", steps: [{ action: "prompt_background", session: null, prompt: [] }] },
      diagnostic: [/save_as/],
    },
    {
      label: "invalid permission",
      value: { id: "bad", permission_mode: "approve-sometimes" },
      diagnostic: [/permission_mode/],
    },
    {
      label: "nonboolean suppression",
      value: {
        id: "bad",
        steps: [{ action: "prompt", session: null, prompt: [], suppress_console_error: "false" }],
      },
      diagnostic: [/suppress_console_error/],
    },
    {
      label: "null expectation",
      value: { id: "bad", steps: [{ action: "new_session", expect_error: null }] },
      diagnostic: [/expect_error/],
    },
    {
      label: "array expectation",
      value: { id: "bad", steps: [{ action: "new_session", expect_error: [] }] },
      diagnostic: [/expect_error/],
    },
    {
      label: "scalar error codes",
      value: { id: "bad", steps: [{ action: "new_session", expect_error: { codes: -32602 } }] },
      diagnostic: [/codes/],
    },
    {
      label: "scalar error messages",
      value: {
        id: "bad",
        steps: [{ action: "new_session", expect_error: { message_any: "invalid" } }],
      },
      diagnostic: [/message_any/],
    },
    {
      label: "wrong check values",
      value: {
        id: "bad",
        checks: [{ type: "saved_stop_reason_in", key: "result", values: "end_turn" }],
      },
      diagnostic: [/values/],
    },
    {
      label: "nonfinite timeout",
      raw: '{"id":"bad","timeouts":{"request_timeout_ms":1e309}}',
      diagnostic: [/request_timeout_ms/],
    },
  ];

for (const scenario of invalidCases) {
  test(`runner rejects ${scenario.label} before launching the adapter`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-invalid-"));
    t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
    const file: CaseFile =
      scenario.raw === undefined
        ? { name: "001-invalid.json", value: scenario.value }
        : { name: "001-invalid.json", raw: scenario.raw };
    const input = await writeInput(directory, { id: "minimal", required_cases: ["bad"] }, [file]);
    const result = await runRunner(input.args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /001-invalid\.json/);
    for (const pattern of scenario.diagnostic) {
      assert.match(result.stderr, pattern);
    }
    assert.equal(result.stdout.trim(), "");
    for (const marker of [input.bootPath, input.tracePath, input.reportPath]) {
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }
  });
}

for (const selection of ["all", "good-only"] as const) {
  test(`runner validates every loaded file before ${selection} execution`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-whole-load-"));
    t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
    const input = await writeInput(
      directory,
      {
        id: "minimal",
        required_cases: selection === "all" ? ["good", "bad"] : ["good"],
      },
      [
        {
          name: "001-good.json",
          value: { id: "good", checks: [{ type: "initialize_protocol_version_number" }] },
        },
        { name: "002-bad.json", value: { id: "bad", checks: [{ type: "unknown_later_check" }] } },
      ],
    );
    const result = await runRunner([
      ...input.args,
      ...(selection === "good-only" ? ["--case", "good"] : []),
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /002-bad\.json/);
    assert.match(result.stderr, /unknown_later_check/);
    assert.equal(result.stdout.trim(), "");
    for (const marker of [input.bootPath, input.tracePath, input.reportPath]) {
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }
  });
}

const invalidProfiles: Array<{
  label: string;
  profile: unknown;
  files: CaseFile[];
  diagnostic: RegExp[];
}> = [
  {
    label: "duplicate case IDs",
    profile: { id: "p", required_cases: ["same"] },
    files: [
      { name: "001-first.json", value: { id: "same" } },
      { name: "002-second.json", value: { id: "same" } },
    ],
    diagnostic: [/same/, /001-first\.json/, /002-second\.json/],
  },
  {
    label: "duplicate required IDs",
    profile: { id: "p", required_cases: ["good", "good"] },
    files: [{ name: "001-good.json", value: { id: "good" } }],
    diagnostic: [/required_cases/, /good/],
  },
  {
    label: "nonstring required ID",
    profile: { id: "p", required_cases: [123] },
    files: [],
    diagnostic: [/profile\.json/, /required_cases/],
  },
  {
    label: "blank profile ID",
    profile: { id: "  ", required_cases: ["good"] },
    files: [{ name: "001-good.json", value: { id: "good" } }],
    diagnostic: [/profile\.json/, /id/],
  },
  {
    label: "missing required case",
    profile: { id: "p", required_cases: ["missing"] },
    files: [],
    diagnostic: [/missing/],
  },
];
for (const scenario of invalidProfiles) {
  test(`runner rejects ${scenario.label} before adapter launch`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-profile-"));
    t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
    const input = await writeInput(directory, scenario.profile, scenario.files);
    const result = await runRunner(input.args);
    assert.equal(result.code, 1, result.stderr);
    for (const pattern of scenario.diagnostic) {
      assert.match(result.stderr, pattern);
    }
    assert.equal(result.stdout.trim(), "");
    for (const marker of [input.bootPath, input.tracePath, input.reportPath]) {
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }
  });
}

test("runner preserves minimal cases, empty arrays, exact IDs and descriptive metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-compatible-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const definitions = [
    { id: " spaced-minimal-id " },
    { id: "check-only", checks: [{ type: "initialize_protocol_version_number" }] },
    { id: "explicit-empty", steps: [], checks: [] },
    { id: "operation-only", steps: [{ action: "new_session" }] },
    {
      id: "metadata",
      title: "Known controls",
      profile: "another-descriptive-scope",
      description: "synthetic",
      timeouts: { request_timeout_ms: 0, update_timeout_ms: 0, settle_timeout_ms: 0 },
      steps: [
        { action: "new_session", save_as: "sid" },
        {
          action: "prompt_background",
          session: "$sid",
          prompt: [{ type: "text", text: "hello" }],
          save_as: "pending",
        },
        { action: "await_background", from: "pending", save_as: "reply" },
        { action: "cancel", session: "$sid" },
        { action: "sleep", ms: 0 },
      ],
      checks: [
        { type: "saved_non_empty_string", key: "sid" },
        { type: "saved_stop_reason_in", key: "reply", values: ["end_turn"] },
        { type: "updates_count_at_least", min: 0 },
        { type: "updates_all_session", session: "$sid" },
        { type: "updates_text_includes", text: "SYNTHETIC" },
        { type: "updates_session_update_includes", values: ["agent_message_chunk"] },
      ],
    },
  ];
  const input = await writeInput(
    directory,
    {
      id: "minimal-profile",
      required_cases: definitions.map(({ id }) => id),
      version: "0.0.0",
      status: "draft",
      description: "synthetic metadata",
      optional_cases: ["not-executed"],
    },
    definitions.map((value, index) => ({ name: `${index + 1}.json`, value })),
  );
  const result = await runRunner(input.args);
  assert.equal(result.code, 0, result.stderr);
  const report = parseReport(result.stdout);
  assert.deepEqual(report.totals, { cases: 5, passed: 5, failed: 0 });
  assert.deepEqual(
    report.results.map(({ id }) => id),
    definitions.map(({ id }) => id),
  );
  assert.equal((await fs.readFile(input.bootPath, "utf8")).trim().split("\n").length, 5);
  const trace = await readCaseWire(input.tracePath);
  assert.equal(
    trace.filter(({ direction, message }) => direction === "in" && message.method === "initialize")
      .length,
    5,
  );
  assert.deepEqual(parseReport(await fs.readFile(input.reportPath, "utf8")).totals, report.totals);
});

test("runner sends intentional invalid ACP payloads unchanged to the peer", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-opaque-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const blocks = [null, { type: "text", text: 123 }, "not-a-block"];
  const input = await writeInput(directory, { id: "minimal", required_cases: ["negative-wire"] }, [
    {
      name: "001-negative.json",
      value: {
        id: "negative-wire",
        steps: [
          { action: "new_session", cwd: 12345, expect_error: {}, save_as: "numeric-cwd" },
          { action: "new_session", cwd: null, expect_error: {}, save_as: "null-cwd" },
          {
            action: "prompt",
            session: 12345,
            prompt: [],
            expect_error: {},
            save_as: "numeric-session",
          },
          {
            action: "prompt",
            session: null,
            prompt: [],
            expect_error: {},
            save_as: "null-session",
          },
          { action: "new_session", save_as: "sid" },
          {
            action: "prompt",
            session: "$sid",
            prompt: blocks,
            expect_error: {},
            save_as: "invalid-blocks",
          },
        ],
        checks: [
          "numeric-cwd",
          "null-cwd",
          "numeric-session",
          "null-session",
          "invalid-blocks",
        ].map((key) => ({ type: "saved_error_present", key })),
      },
    },
  ]);
  const result = await runRunner(input.args);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseReport(result.stdout).totals, { cases: 1, passed: 1, failed: 0 });
  const trace = await readCaseWire(input.tracePath);
  const requests = trace.filter(({ direction }) => direction === "in");
  const sessions = requests.filter(({ message }) => message.method === "session/new");
  const prompts = requests.filter(({ message }) => message.method === "session/prompt");
  assert.deepEqual(
    sessions.slice(0, 2).map(({ message }) => message.params?.cwd),
    [12345, null],
  );
  assert.deepEqual(
    prompts.map(({ message }) => message.params?.sessionId),
    [12345, null, "synthetic-session"],
  );
  assert.deepEqual(prompts[2]?.message.params?.prompt, blocks);
  assert.equal(sessions.length, 3);
  assert.equal(prompts.length, 3);
  for (const request of [...sessions.slice(0, 2), ...prompts]) {
    assertPeerError(trace, request);
  }
});

test("expected-error empty filters and combined filters retain wire-proved behavior", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-f1-error-filters-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const expectations = [
    {},
    { codes: [], message_any: [] },
    { codes: [-32602], message_any: ["INVALID CWD"] },
    { codes: [-32601], message_any: ["invalid cwd"] },
    { codes: [-32602], message_any: ["different message"] },
  ];
  const definitions = expectations.map((expect_error, index) => ({
    id: `error-${index}`,
    steps: [{ action: "new_session", cwd: 12345, expect_error, save_as: "error" }],
    checks: [{ type: "saved_error_present", key: "error" }],
  }));
  const input = await writeInput(
    directory,
    { id: "minimal", required_cases: definitions.map(({ id }) => id) },
    definitions.map((value, index) => ({ name: `${index + 1}.json`, value })),
  );
  const result = await runRunner(input.args);
  assert.equal(result.code, 1, result.stderr);
  const report = parseReport(result.stdout);
  assert.deepEqual(report.totals, { cases: 5, passed: 3, failed: 2 });
  assert.deepEqual(
    report.results.map(({ passed }) => passed),
    [true, true, true, false, false],
  );
  assert.match(report.results[3]?.error ?? "", /error code/i);
  assert.match(report.results[4]?.error ?? "", /error message/i);
  const trace = await readCaseWire(input.tracePath);
  const requests = trace.filter(
    ({ direction, message }) => direction === "in" && message.method === "session/new",
  );
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assertPeerError(trace, request);
  }
});

test("saved checks and references use literal own keys", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-case-saved-keys-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const definitions = [
    ...["__proto__", "constructor", "toString"].map((key) => ({
      id: `unsaved-${key}`,
      checks: [{ type: "saved_error_present", key }],
    })),
    {
      id: "literal-prototype-key",
      steps: [
        { action: "new_session", save_as: "__proto__" },
        {
          action: "prompt",
          session: "$__proto__",
          prompt: [{ type: "text", text: "Use the saved session" }],
          save_as: "constructor",
        },
      ],
      checks: [
        { type: "saved_non_empty_string", key: "__proto__" },
        { type: "saved_stop_reason_in", key: "constructor", values: ["end_turn"] },
      ],
    },
  ];
  const input = await writeInput(
    directory,
    { id: "saved-keys", required_cases: definitions.map(({ id }) => id) },
    definitions.map((value, index) => ({ name: `${index}.json`, value })),
  );
  const result = await runRunner(input.args);
  assert.equal(result.code, 1, result.stderr);
  const report = parseReport(result.stdout);
  assert.deepEqual(
    report.results.map(({ passed }) => passed),
    [false, false, false, true],
  );
  const trace = await readCaseWire(input.tracePath);
  const creation = trace.find(
    ({ direction, message }) => direction === "in" && message.method === "session/new",
  );
  assert.ok(creation);
  const created = trace.find(
    ({ pid, direction, message }) =>
      pid === creation.pid &&
      direction === "out" &&
      message.id === creation.message.id &&
      !message.method,
  );
  const promptRequest = trace.find(
    ({ pid, direction, message }) =>
      pid === creation.pid && direction === "in" && message.method === "session/prompt",
  );
  assert.ok(
    created?.message.result &&
      typeof created.message.result === "object" &&
      "sessionId" in created.message.result,
  );
  assert.equal(promptRequest?.message.params?.sessionId, created.message.result.sessionId);
});
