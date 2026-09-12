import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

test("lint script covers conformance runner sources", () => {
  const pkg = readPackageJson();
  const lintScript = pkg.scripts?.lint ?? "";

  assert.match(pkg.scripts?.["conformance:run"] ?? "", /\bconformance\/runner\/run\.ts\b/);
  assert.match(lintScript, /\bconformance\b/);
});

test("lockfile keeps project dependencies visible to single-document consumers", () => {
  const lockfile = readFileSync(path.join(process.cwd(), "pnpm-lock.yaml"), "utf8");
  const documents = lockfile.split(/^---\s*$/m).filter((document) => document.trim());

  // Dependabot currently reads only the first document (dependabot-core#15904).
  assert.equal(documents.length, 1, "The dependency graph must remain a single YAML document");
  assert.match(documents[0], /\nimporters:\n/);
  assert.match(documents[0], /\n {4}dependencies:\n/);
});

test("coverage script excludes generated package output", () => {
  const pkg = readPackageJson();
  const coverageScript = pkg.scripts?.["test:coverage"] ?? "";

  assert.match(coverageScript, /\bc8\b/);
  assert.match(coverageScript, /--all\b/);
  assert.match(coverageScript, /--check-coverage\b/);
  assert.match(coverageScript, /--lines 85\b/);
  assert.match(coverageScript, /--branches 85\b/);
  assert.match(coverageScript, /--functions 85\b/);
  assert.match(coverageScript, /--statements 85\b/);
  assert.match(coverageScript, /dist-test\/src\/flows\/schema\.js/);
  assert.match(coverageScript, /dist-test\/src\/runtime\/public\/\*\*\/\*\.js/);
  assert.match(coverageScript, /dist-test\/src\/runtime\/engine\/manager\.js/);
  assert.match(coverageScript, /node --test dist-test\/test\/\*\.test\.js && c8\b/);
  assert.match(coverageScript, /dist-test\/test\/flows\.test\.js/);
  assert.match(coverageScript, /dist-test\/test\/runtime-manager\.test\.js/);
  assert.match(coverageScript, /--exclude ['"]?dist\/\*\*\/\*\.js['"]?/);
});

test("slophammer is CI-only and enforces latest DRY plus dependency boundaries", () => {
  const pkg = readPackageJson();
  const ciWorkflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "ci.yml"),
    "utf8",
  );

  assert.equal(pkg.dependencies?.["slophammer-ts"], undefined);
  assert.equal(pkg.devDependencies?.["slophammer-ts"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg.scripts ?? {}), /slophammer-ts/);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest rules --format text/);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest dry \./);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest check \. --only/);
  assert.match(ciWorkflow, /ts\.dependency-boundaries-required/);
  assert.doesNotMatch(ciWorkflow, /assert-slophammer-rules-clean\.mjs/);
});

test("slophammer config uses the published v0.3+ TypeScript schema", () => {
  const config = readFileSync(path.join(process.cwd(), "slophammer.yml"), "utf8");

  assert.match(config, /typescript:\n/);
  assert.match(config, /coverage:\n\s+threshold: 85/);
  assert.match(config, /complexity:\n\s+max: 8/);
  assert.match(
    config,
    /pattern: ["']dist-test\/\*\*["']\n\s+reason: generated test compilation output/,
  );
  assert.match(
    config,
    /pattern: ["']examples\/flows\/replay-viewer\/dist\/\*\*["']\n\s+reason: generated replay-viewer build output/,
  );
  assert.match(config, /mutation:\n\s+targets:\n\s+- src\/cli\/flags\.ts/);
  assert.doesNotMatch(config, /coverage_threshold/);
  assert.doesNotMatch(config, /complexity_max/);
  assert.doesNotMatch(config, /mutation_targets/);
});

test("test scripts build packaged output before running package-bin smoke tests", () => {
  const pkg = readPackageJson();

  assert.match(pkg.scripts?.test ?? "", /^pnpm run build && pnpm run build:test && /);
  assert.match(pkg.scripts?.["test:coverage"] ?? "", /^pnpm run build && pnpm run build:test && /);
});

test("documentation lint rejects unterminated TOML configuration without hanging", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "acpx-doclint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, "invalid.toml");
  writeFileSync(config, "a=[1 #");
  writeFileSync(path.join(directory, "README.md"), "# Fixture\n");
  const require = createRequire(import.meta.url);
  const cli = path.join(
    path.dirname(require.resolve("markdownlint-cli2")),
    "markdownlint-cli2-bin.mjs",
  );

  const result = spawnSync(process.execPath, [cli, "--config", config, "README.md"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.error, undefined, "documentation lint must exit before the timeout");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Invalid TOML document: cannot find end of structure/);
});
