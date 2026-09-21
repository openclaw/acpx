import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const RELEASE_TAG = "v1.2.3";
const STEP_HEADER = "      - name: Validate release tag";
const NEXT_STEP_HEADER = "      - name: Ensure version is not already published";

function releaseValidationScript(workflow: string): string {
  const lines = workflow.split(/\r?\n/u);
  assert.equal(lines.filter((line) => line === STEP_HEADER).length, 1);
  const start = lines.indexOf(STEP_HEADER);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("      - "));
  assert.ok(end > start, "Release validation must have an explicit following step");
  assert.equal(lines[end], NEXT_STEP_HEADER);
  const step = lines.slice(start, end);
  assert.deepEqual(step.slice(0, 5), [
    STEP_HEADER,
    "        env:",
    "          RELEASE_SHA: ${{ github.sha }}",
    "          RELEASE_TAG: ${{ github.ref_name }}",
    "        run: |",
  ]);

  const body = step.slice(5).map((line) => {
    if (line.trim() === "") {
      return "";
    }
    assert.ok(line.startsWith("          "), "Unexpected field outside the validation run block");
    return line.slice(10);
  });
  while (body.at(-1) === "") {
    body.pop();
  }
  assert.equal(body[0], "set -euo pipefail");
  assert.ok(
    body[1] === "git fetch --no-tags origin main" ||
      body[1] === "git fetch --no-tags origin main --depth=1",
    "Unexpected release fetch command; inspect the test boundary before updating it",
  );
  assert.equal(body[2], "");
  assert.equal(body[3], "node - <<'NODE'");
  assert.ok(body.length > 5, "The inline Node validator must not be empty");
  assert.equal(
    body.indexOf("NODE", 4),
    body.length - 1,
    "No shell commands may follow the validator",
  );
  return `${body.join("\n")}\n`;
}

function createFixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-release-ancestry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  const hooks = path.join(directory, "hooks");
  const config = path.join(directory, "empty.gitconfig");
  for (const child of [home, bin, hooks]) {
    mkdirSync(child);
  }
  writeFileSync(config, "");

  // The release job is Linux; these system executables also exist on supported local Macs.
  const nativeGit = realpathSync("/usr/bin/git");
  symlinkSync(nativeGit, path.join(bin, "git"));
  symlinkSync(realpathSync(process.execPath), path.join(bin, "node"));
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: hooks,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "tag.gpgsign",
    GIT_CONFIG_VALUE_2: "false",
  };

  function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${command} did not complete: ${result.error?.message}`);
    assert.equal(result.signal, null, `${command} terminated by a signal`);
    return result;
  }

  function git(cwd: string, ...args: string[]): string {
    const result = run(nativeGit, args, cwd);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout.trim();
  }

  const origin = path.join(directory, "origin");
  const checkout = path.join(directory, "checkout");
  git(directory, "init", "--quiet", "--initial-branch=main", origin);
  writeFileSync(path.join(origin, "package.json"), '{"version":"1.2.3"}\n');

  function commit(label: string): string {
    writeFileSync(path.join(origin, "fixture.txt"), `${label}\n`);
    git(origin, "add", "package.json", "fixture.txt");
    git(origin, "commit", "--quiet", "--message", label);
    return git(origin, "rev-parse", "HEAD");
  }

  return { directory, origin, checkout, nativeGit, run, git, commit };
}

type Scenario = "tip" | "behind" | "advanced" | "divergent";
const scenarios: { name: Scenario; expectedExit: number; expectedInitialAncestry: number }[] = [
  { name: "tip", expectedExit: 0, expectedInitialAncestry: 0 },
  { name: "behind", expectedExit: 0, expectedInitialAncestry: 0 },
  { name: "advanced", expectedExit: 0, expectedInitialAncestry: 0 },
  { name: "divergent", expectedExit: 1, expectedInitialAncestry: 1 },
];

for (const scenario of scenarios) {
  test(
    `release validation preserves main membership when the release is ${scenario.name}`,
    { skip: process.platform === "win32", timeout: 60_000 },
    (t) => {
      const workflow = readFileSync(
        path.join(process.cwd(), ".github", "workflows", "release.yml"),
        "utf8",
      );
      const script = releaseValidationScript(workflow);
      const fixture = createFixture(t);
      const { origin, checkout, git, commit } = fixture;
      const base = commit("base");
      let releaseSha = base;
      let mainSha = base;
      if (scenario.name !== "advanced") {
        mainSha = commit("main advances");
      }
      if (scenario.name === "tip") {
        releaseSha = mainSha;
      }
      if (scenario.name === "divergent") {
        git(origin, "checkout", "--quiet", "-b", "side", base);
        releaseSha = commit("side branch");
        git(origin, "checkout", "--quiet", "main");
      }
      git(origin, "tag", RELEASE_TAG, releaseSha);
      git(fixture.directory, "clone", "--quiet", pathToFileURL(origin).href, checkout);
      git(checkout, "checkout", "--quiet", "--detach", RELEASE_TAG);
      assert.equal(git(checkout, "rev-parse", "HEAD"), releaseSha);
      const shallowBefore = git(checkout, "rev-parse", "--is-shallow-repository");
      assert.equal(shallowBefore, "false");
      const beforeMain = git(checkout, "rev-parse", "origin/main");
      assert.equal(beforeMain, mainSha);
      const initialAncestry = fixture.run(
        fixture.nativeGit,
        ["merge-base", "--is-ancestor", releaseSha, "origin/main"],
        checkout,
      );
      assert.equal(initialAncestry.status, scenario.expectedInitialAncestry);
      if (scenario.name === "advanced") {
        mainSha = commit("main advances after checkout");
        assert.notEqual(mainSha, beforeMain);
      }

      const result = fixture.run("/bin/bash", ["--noprofile", "--norc", "-c", script], checkout, {
        RELEASE_SHA: releaseSha,
        RELEASE_TAG,
      });
      const afterMain = git(checkout, "rev-parse", "origin/main");
      const afterAncestry = fixture.run(
        fixture.nativeGit,
        ["merge-base", "--is-ancestor", releaseSha, "origin/main"],
        checkout,
      );
      t.diagnostic(
        JSON.stringify({
          scenario: scenario.name,
          workflowSha256: createHash("sha256").update(workflow).digest("hex"),
          gitVersion: git(checkout, "--version"),
          releaseSha,
          beforeMain,
          afterMain,
          initialAncestry: initialAncestry.status,
          afterAncestry: afterAncestry.status,
          shallowBefore,
          shallowAfter: git(checkout, "rev-parse", "--is-shallow-repository"),
          validationExit: result.status,
          validationStdout: result.stdout,
          validationStderr: result.stderr.replaceAll(fixture.directory, "<fixture>"),
        }),
      );
      assert.equal(afterMain, mainSha, "Validation must refresh the main tracking reference");
      assert.equal(result.status, scenario.expectedExit, result.stderr);
      assert.equal(afterAncestry.status, scenario.expectedExit, afterAncestry.stderr);
      if (scenario.expectedExit === 0) {
        assert.equal(
          result.stdout.trim(),
          `Release tag ${RELEASE_TAG} matches package.json and points to a commit on origin/main.`,
        );
      } else {
        assert.ok(
          result.stderr.includes(`Tagged commit ${releaseSha} is not contained in origin/main.`),
          result.stderr,
        );
      }
    },
  );
}
