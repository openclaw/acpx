import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("slophammer config uses the published v0.2 TypeScript schema", () => {
  const config = readFileSync(path.join(process.cwd(), "slophammer.yml"), "utf8");

  assert.match(config, /typescript:\n/);
  assert.match(config, /coverage:\n\s+threshold: 85/);
  assert.match(config, /complexity:\n\s+max: 8/);
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
