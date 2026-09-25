import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCaseDefinition } from "../conformance/runner/schema.js";
import { parseReport, runRunner } from "./conformance-test-helpers.js";

const CORE_CASES = [
  "acp.v1.session.prompt.single_turn",
  "acp.v1.session.update.termination",
  "acp.v1.session.prompt.multi_turn",
];
const session = (save_as = "session") => ({ action: "new_session", save_as });
const prompt = (save_as?: string, sessionId = "$session", text = "one") => ({
  action: "prompt",
  session: sessionId,
  prompt: [{ type: "text", text }],
  ...(save_as === undefined ? {} : { save_as }),
});
const background = (save_as: string, sessionId = "$session", text = "one") => ({
  ...prompt(save_as, sessionId, text),
  action: "prompt_background",
});
const count = (from: string, min = 1) => ({ type: "updates_count_at_least", from, min });
type Case = { steps: object[]; checks: object[] };

async function run(mode: string, cases?: Case[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-prompt-scopes-"));
  try {
    const command = [
      process.execPath,
      fileURLToPath(new URL("./fixtures/conformance-prompt-scope-agent.js", import.meta.url)),
      mode,
    ]
      .map((argument) => JSON.stringify(argument))
      .join(" ");
    const args = ["--cwd", directory, "--agent-command", command, "--format", "json"];
    if (cases) {
      const casesDir = path.join(directory, "cases");
      await fs.mkdir(casesDir);
      for (const [index, value] of cases.entries()) {
        await fs.writeFile(
          path.join(casesDir, `${index}.json`),
          JSON.stringify({ id: `scope.${index}`, ...value }),
        );
      }
      const profile = path.join(directory, "profile.json");
      await fs.writeFile(
        profile,
        JSON.stringify({ id: "scopes", required_cases: cases.map((_, i) => `scope.${i}`) }),
      );
      args.push("--profile", profile, "--cases-dir", casesDir);
    } else {
      args.push(...CORE_CASES.flatMap((id) => ["--case", id]));
    }
    const result = await runRunner(args);
    return { ...result, report: parseReport(result.stdout) };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const [mode, expected] of [
  ["preprompt", [false, false, false]],
  ["turn1-only", [true, true, false]],
  ["turn2-only", [false, false, false]],
  ["before", [true, true, true]],
] as const) {
  test(`built-in prompt cases reject borrowed updates: ${mode}`, async () => {
    const result = await run(mode);
    assert.deepEqual(
      result.report.results.map((row) => row.passed),
      expected,
      result.stderr,
    );
    assert.equal(result.code, expected.every(Boolean) ? 0 : 1);
    for (const row of result.report.results.filter((row) => !row.passed)) {
      assert.match(row.error ?? "", /expected at least 1 updates from/);
    }
  });
}

for (const [mode, minimum, passed] of [
  ["before", 1, true],
  ["after", 1, false],
  ["duplicates", 1, true],
  ["duplicates", 2, false],
  ["invalid", 1, false],
  ["normalized", 1, true],
  ["normalized", 2, false],
  ["wrong-session", 1, false],
] as const) {
  test(`scoped callbacks preserve SDK acceptance and completion: ${mode}, min${minimum}`, async () => {
    const result = await run(mode, [
      { steps: [session(), prompt("turn"), session("barrier")], checks: [count("turn", minimum)] },
    ]);
    assert.equal(result.report.results[0]?.passed, passed, result.stderr);
    assert.equal(result.code, passed ? 0 : 1);
  });
}

test("background and awaited aliases keep the original scope after late output", async () => {
  const steps = [
    session(),
    background("work"),
    session("barrier"),
    { action: "await_background", from: "work", save_as: "result" },
  ];
  const result = await run("before-after", [
    {
      steps,
      checks: [
        count("work"),
        count("result"),
        { type: "updates_count_at_least", min: 2 },
        { type: "saved_stop_reason_in", key: "result", values: ["end_turn"] },
      ],
    },
    { steps, checks: [count("work", 2)] },
    { steps, checks: [count("result", 2)] },
  ]);
  assert.deepEqual(
    result.report.results.map((row) => row.passed),
    [true, false, false],
  );
});

test("same-session overlap remains ambiguous after settlement, including unsaved prompts", async () => {
  const steps = [
    session(),
    background("work"),
    prompt(),
    { action: "await_background", from: "work", save_as: "alias" },
  ];
  const result = await run("overlap", [
    { steps, checks: [count("work", 0)] },
    { steps, checks: [count("alias", 0)] },
  ]);
  for (const row of result.report.results) {
    assert.equal(row.passed, false);
    assert.match(row.error ?? "", /ambiguous: overlapping prompts/);
  }
});

test("different-session overlap counts only matching callbacks", async () => {
  const steps = [
    session("a"),
    session("b"),
    background("first", "$a"),
    background("second", "$b"),
    { action: "await_background", from: "first" },
    { action: "await_background", from: "second" },
  ];
  const result = await run("overlap", [
    {
      steps,
      checks: [count("first"), count("second"), { type: "updates_count_at_least", min: 3 }],
    },
    { steps, checks: [count("first", 2)] },
    { steps, checks: [count("second", 2)] },
  ]);
  assert.deepEqual(
    result.report.results.map((row) => row.passed),
    [true, false, false],
  );
});

test("old background completion cannot rebind a newer foreground name", async () => {
  const steps = [
    session("a"),
    session("b"),
    background("work", "$a", "hold"),
    prompt("work", "$b", "finish"),
    session("barrier"),
    { action: "await_background", from: "work", save_as: "old_alias" },
  ];
  const result = await run("reorder", [
    { steps, checks: [count("work"), count("old_alias", 2)] },
    { steps, checks: [count("work", 2)] },
  ]);
  assert.deepEqual(
    result.report.results.map((row) => row.passed),
    [true, false],
  );
});

test("aliases stay on their original attempt when a source name is reused", async () => {
  const result = await run("before", [
    {
      steps: [
        session(),
        background("work", "$session", "two"),
        { action: "await_background", from: "work", save_as: "old_alias" },
        prompt("work"),
      ],
      checks: [count("old_alias", 2), count("work")],
    },
    {
      steps: [
        session(),
        background("work", "$session", "two"),
        { action: "await_background", from: "work", save_as: "old_alias" },
        prompt("work"),
      ],
      checks: [count("work", 2)],
    },
    {
      steps: [
        session(),
        background("work", "$session", "two"),
        session("work"),
        { action: "await_background", from: "work", save_as: "restored_alias" },
      ],
      checks: [
        count("restored_alias", 2),
        { type: "saved_stop_reason_in", key: "restored_alias", values: ["end_turn"] },
      ],
    },
  ]);
  assert.deepEqual(
    result.report.results.map((row) => row.passed),
    [true, false, true],
  );
});

test("missing, overwritten, invalid and unsettled sources fail even with a zero minimum", async () => {
  const missing = await run("before", [
    { steps: [session()], checks: [count("missing", 0)] },
    { steps: [session(), prompt("work"), session("work")], checks: [count("work", 0)] },
  ]);
  for (const row of missing.report.results) {
    assert.equal(row.passed, false);
    assert.match(row.error ?? "", /Unknown prompt update source/);
  }
  const invalid = await run("before", [
    {
      steps: [{ ...prompt("invalid"), session: null }],
      checks: [count("invalid", 0)],
    },
  ]);
  assert.equal(invalid.report.results[0]?.passed, false);
  assert.match(invalid.report.results[0]?.error ?? "", /no valid session/);
  const pending = await run("pending", [
    { steps: [session(), background("work"), session("barrier")], checks: [count("work", 0)] },
  ]);
  assert.equal(pending.report.results[0]?.passed, false);
  assert.match(pending.report.results[0]?.error ?? "", /still unsettled/);
});

test("source names remain literal and safe for prototype-like spellings", async () => {
  const result = await run(
    "before",
    ["__proto__", "constructor", "$literal", "${saved.x}"].map((name) => ({
      steps: [session(), prompt(name)],
      checks: [count(name), { type: "saved_stop_reason_in", key: name, values: ["end_turn"] }],
    })),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.totals.passed, 4);
});

test("a rejected prompt closes its update scope without changing the saved error", async () => {
  const steps = [
    session(),
    { ...prompt("turn"), expect_error: { codes: [-32602] } },
    session("barrier"),
  ];
  const result = await run("reject", [
    { steps, checks: [count("turn"), { type: "saved_error_present", key: "turn" }] },
    { steps, checks: [count("turn", 2)] },
    {
      steps: [
        session(),
        background("work"),
        session("barrier"),
        {
          action: "await_background",
          from: "work",
          save_as: "error_alias",
          expect_error: { codes: [-32602] },
        },
      ],
      checks: [
        count("work"),
        count("error_alias"),
        { type: "saved_error_present", key: "error_alias" },
      ],
    },
  ]);
  assert.deepEqual(
    result.report.results.map((row) => row.passed),
    [true, false, true],
  );
});

test("only count checks accept a nonempty literal from", () => {
  for (const from of [null, 1, "", {}]) {
    assert.throws(
      () =>
        parseCaseDefinition({ id: "invalid", checks: [{ ...count("turn"), from }] }, "case.json"),
      /Invalid conformance file/,
    );
  }
  assert.throws(
    () =>
      parseCaseDefinition(
        { id: "invalid", checks: [{ type: "updates_text_includes", text: "x", from: "turn" }] },
        "case.json",
      ),
    /Invalid conformance file/,
  );
});
