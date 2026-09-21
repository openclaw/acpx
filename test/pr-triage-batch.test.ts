import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

type PrInput = { repo: string; prNumber: number };
type BatchResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  tmp: string;
  calls: string[][];
};

function runBatch(t: TestContext, bash: string, args: string[]): BatchResult {
  const root = mkdtempSync(path.join(os.tmpdir(), "acpx-pr-batch fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const tmp = path.join(root, "tmp");
  const home = path.join(root, "home");
  for (const directory of [bin, tmp, home]) {
    mkdirSync(directory);
  }
  const recording = path.join(root, "tmux.argv");
  const pnpmMarker = path.join(root, "pnpm-executed");

  // Record the requested session; never execute its queued shell command.
  writeFileSync(
    path.join(bin, "tmux"),
    '#!/bin/sh\nprintf \'%s\\000\' "$@" >> "$ACPX_BATCH_TMUX_RECORD"\nprintf \'\\000\' >> "$ACPX_BATCH_TMUX_RECORD"\n',
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(bin, "pnpm"),
    "#!/bin/sh\nprintf 'unexpected pnpm execution\\n' > \"$ACPX_BATCH_PNPM_EXECUTED\"\nexit 97\n",
    { mode: 0o700 },
  );

  const result = spawnSync(
    bash,
    [path.join(process.cwd(), "scripts/run-pr-triage-batch.sh"), ...args],
    {
      cwd: home,
      env: {
        PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
        HOME: home,
        TMPDIR: tmp,
        LC_ALL: "C",
        ACPX_BATCH_TMUX_RECORD: recording,
        ACPX_BATCH_PNPM_EXECUTED: pnpmMarker,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined, `${bash}: ${result.error?.message}`);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(existsSync(pnpmMarker), false, "No flow may run through the inert tmux fixture");
  const calls = existsSync(recording)
    ? readFileSync(recording, "utf8")
        .split("\0\0")
        .filter(Boolean)
        .map((call) => call.split("\0"))
    : [];
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, tmp, calls };
}

function assertStarted(result: BatchResult, expected: PrInput[]): void {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.calls.length, expected.length);
  const directories = readdirSync(result.tmp);
  assert.equal(directories.length, 1, "One invocation owns one batch directory");
  const batch = path.join(result.tmp, directories[0]);
  const [header, ...rows] = readFileSync(path.join(batch, "started.tsv"), "utf8")
    .trimEnd()
    .split("\n");
  assert.equal(header, "pr\tlauncher\tlog\tinput");
  assert.equal(rows.length, expected.length);
  assert.equal(
    readdirSync(batch).filter((name) => name.endsWith(".input.json")).length,
    expected.length,
  );

  const inputPaths = new Set<string>();
  const logPaths = new Set<string>();
  const sessions = new Set<string>();
  rows.forEach((row, index) => {
    const fields = row.split("\t");
    assert.equal(fields.length, 4);
    const [reference, launcher, log, input] = fields;
    const pr = expected[index];
    assert.equal(reference, `${pr.repo}#${pr.prNumber}`);
    assert.equal(path.dirname(input), batch);
    assert.equal(path.dirname(log), batch);
    assert.deepEqual(JSON.parse(readFileSync(input, "utf8")), pr);

    const call = result.calls[index];
    assert.equal(call.length, 5);
    assert.deepEqual(call.slice(0, 3), ["new-session", "-d", "-s"]);
    const [, , , session, command] = call;
    assert.equal(launcher, `tmux:${session}`);
    assert.doesNotMatch(session, /[.:]/, "tmux session names cannot contain dots or colons");
    assert.ok(command.includes(path.basename(input)), "The queued job must use its own input");
    assert.ok(command.includes(path.basename(log)), "The queued job must use its own log");
    assert.ok(result.stdout.includes(`started PR ${reference} in tmux session ${session}`));
    inputPaths.add(input);
    logPaths.add(log);
    sessions.add(session);
  });
  assert.equal(inputPaths.size, expected.length, "Different targets need separate inputs");
  assert.equal(logPaths.size, expected.length, "Different targets need separate logs");
  assert.equal(sessions.size, expected.length, "Different targets need separate sessions");
}

const bashExecutables = [
  "/bin/bash",
  ...(process.platform === "darwin"
    ? ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"].filter(existsSync)
    : []),
];

for (const bash of bashExecutables) {
  test(
    `PR batch preserves target identities and canonical numbers under ${bash}`,
    { skip: process.platform === "win32" },
    (t) => {
      const result = runBatch(t, bash, [
        "#00178",
        "178",
        "https://github.com/OpenClaw/AcPx/pull/000178",
        "HTTPS://GITHUB.COM/openclaw/acpx/pull/00178",
        "https://github.com/example/other.repo_name/pull/00178",
        "https://github.com/EXAMPLE/OTHER.REPO_NAME/pull/178",
        "00009",
        "https://github.com/other-owner/other_repo/pull/00009",
        "00010",
        "9007199254740991",
        "0009007199254740991",
      ]);
      assertStarted(result, [
        { repo: "openclaw/acpx", prNumber: 178 },
        { repo: "example/other.repo_name", prNumber: 178 },
        { repo: "openclaw/acpx", prNumber: 9 },
        { repo: "other-owner/other_repo", prNumber: 9 },
        { repo: "openclaw/acpx", prNumber: 10 },
        { repo: "openclaw/acpx", prNumber: 9007199254740991 },
      ]);
    },
  );

  test(
    `PR batch rejects every malformed reference before dispatch under ${bash}`,
    { skip: process.platform === "win32" },
    (t) => {
      const invalid = [
        "",
        "0",
        "000",
        "#000",
        "##178",
        "-1",
        "+178",
        "1.5",
        "1e3",
        " 178",
        "178 ",
        "178\n",
        "9007199254740992",
        "9007199254740993",
        `1${"0".repeat(100)}`,
        "arbitrary/path/178",
        "https://example.invalid/openclaw/acpx/pull/178",
        "http://github.com/openclaw/acpx/pull/178",
        "https://github.com/openclaw/acpx/pull/extra/178",
        "https://github.com/openclaw/acpx/pull/178/",
        "https://github.com/openclaw/acpx/pull/178?view=files",
        "https://github.com/openclaw/acpx/pull/178#discussion",
        "https://github.com/openclaw/acpx/pull/0",
        "https://github.com/openclaw/acpx/pull/9007199254740992",
        "https://github.com/openclaw/../pull/178",
        "https://github.com/openclaw/./pull/178",
        "https://github.com//acpx/pull/178",
        "https://github.com/openclaw//pull/178",
      ];
      for (const argument of invalid) {
        const result = runBatch(t, bash, ["178", argument, "179"]);
        assert.notEqual(result.exitCode, 0, JSON.stringify(argument));
        assert.match(result.stderr, /Invalid PR argument:/);
        assert.deepEqual(result.calls, [], JSON.stringify(argument));
        assert.deepEqual(readdirSync(result.tmp), [], "Invalid batches must not create inputs");
        assert.doesNotMatch(result.stdout, /started PR/);
      }
    },
  );

  test(
    `PR batch without arguments prints usage without dispatch under ${bash}`,
    { skip: process.platform === "win32" },
    (t) => {
      const result = runBatch(t, bash, []);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /Usage:/);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(readdirSync(result.tmp), []);
    },
  );
}
