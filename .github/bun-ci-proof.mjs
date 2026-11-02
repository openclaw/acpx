import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const results = [];
const bun = path.join(process.env.RUNNER_TEMP, "bun-ci-tools/bun-linux-x64/bun");
const baseline = {
  format: ["pnpm", ["exec", "oxfmt", "--check"]],
  typecheck: ["pnpm", ["exec", "tsc", "--noEmit", "--pretty", "false"]],
};
const candidate = {
  format: [bun, ["fmt", "--no-script", "--check"]],
  typecheck: [bun, ["check", "--no-script", "--no-pretty"]],
};

function run(label, command) {
  const started = performance.now();
  const child = spawnSync(command[0], command[1], {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const result = {
    label,
    milliseconds: performance.now() - started,
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdout: child.stdout?.slice(0, 14000),
    stderr: child.stderr?.slice(0, 14000),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  return result;
}

run("node-version", ["node", ["--version"]]);
run("pnpm-version", ["pnpm", ["--version"]]);
run("typescript-version", ["pnpm", ["exec", "tsc", "--version"]]);
run("oxfmt-version", ["pnpm", ["exec", "oxfmt", "--version"]]);
run("bun-version", [bun, ["--revision"]]);
run("bun-embedded-typescript", [bun, ["-e", "console.log(process.versions.typescript)"]]);
const head = run("head", ["git", ["rev-parse", "HEAD"]]).stdout.trim();
const source = run("source-parent", ["git", ["rev-parse", "HEAD^"]]).stdout.trim();
const lockfile = createHash("sha256").update(fs.readFileSync("pnpm-lock.yaml")).digest("hex");

for (const category of ["format", "typecheck"]) {
  run(`${category}-baseline-first`, baseline[category]);
  run(`${category}-candidate-first`, candidate[category]);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const order = repetition % 2 === 0 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    for (const tool of order)
      run(
        `${category}-${tool}-hot-${repetition + 1}`,
        (tool === "baseline" ? baseline : candidate)[category],
      );
  }
}

const typeFixture = "src/bun-ci-proof-negative.ts";
const typeControls = [
  ["assignment", 'export const invalid: number = "not a number";\n'],
  ["nullability", "export const invalid: string = null;\n"],
  ["implicit-any", "export function invalid(value) { return value; }\n"],
  ["unused-local", "const unused = 1;\nexport {};\n"],
  ["unused-parameter", "export function invalid(unused: string) { return 1; }\n"],
  ["property", "export const invalid = ({ value: 1 }).absent;\n"],
];
try {
  for (const [name, contents] of typeControls) {
    fs.writeFileSync(typeFixture, contents);
    run(`negative-${name}-baseline`, baseline.typecheck);
    run(`negative-${name}-candidate`, candidate.typecheck);
  }
} finally {
  fs.rmSync(typeFixture, { force: true });
}

const parity = [];
const specimens = [
  ["ts", 'export const value={name:"hello",items:[1,2,3]}\n'],
  ["json", '{"value":1,"names":["one","two"]}\n'],
  ["md", "# title\n\n-   item\n\n```ts\nconst x={value:1}\n```\n"],
  ["yml", "name: proof\nitems: [one,two,three]\n"],
];
for (const [extension, contents] of specimens) {
  const fixture = `bun-ci-proof-negative.${extension}`;
  try {
    fs.writeFileSync(fixture, contents);
    const baselineNegative = run(`negative-format-${extension}-baseline`, [
      "pnpm",
      ["exec", "oxfmt", "--check", fixture],
    ]);
    const candidateNegative = run(`negative-format-${extension}-candidate`, [
      bun,
      ["fmt", "--no-script", "--check", fixture],
    ]);
    const baselineWrite = run(`write-${extension}-baseline`, [
      "pnpm",
      ["exec", "oxfmt", "--write", fixture],
    ]);
    const baselineOutput = fs.readFileSync(fixture, "utf8");
    fs.writeFileSync(fixture, contents);
    const candidateWrite = run(`write-${extension}-candidate`, [
      bun,
      ["fmt", "--no-script", fixture],
    ]);
    const candidateOutput = fs.readFileSync(fixture, "utf8");
    run(`idempotence-${extension}-candidate`, [bun, ["fmt", "--no-script", fixture]]);
    parity.push({
      extension,
      baselineNegative: baselineNegative.status,
      candidateNegative: candidateNegative.status,
      baselineWrite: baselineWrite.status,
      candidateWrite: candidateWrite.status,
      equal: baselineOutput === candidateOutput,
      idempotent: candidateOutput === fs.readFileSync(fixture, "utf8"),
      baselineOutput,
      candidateOutput,
    });
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

const report = {
  head,
  source,
  mode: process.env.PROOF_MODE,
  runner: {
    platform: process.platform,
    architecture: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0].model,
    release: os.release(),
  },
  lockfile,
  results,
  parity,
  caveats: [
    "first invocation is after dependency install, not OS-cold",
    "cold means empty task tool/store cache; restored means fresh hosted job with an exact-key cache hit",
    "both commands share unchanged dependencies; candidate-only tool provisioning is recorded separately",
    "hot repetitions restart processes and do not claim incremental compiler reuse",
  ],
};
console.log(`BUN_CI_PROOF_JSON=${JSON.stringify(report)}`);
const valid = results.filter((result) =>
  /^(format|typecheck)-(baseline|candidate)-(first|hot-)/.test(result.label),
);
const negative = results.filter((result) =>
  /^negative-(assignment|nullability|implicit-any|unused-local|unused-parameter|property)-/.test(
    result.label,
  ),
);
if (
  valid.some((result) => result.status !== 0) ||
  negative.some((result) => result.status === 0) ||
  parity.some(
    (result) =>
      !result.equal ||
      !result.idempotent ||
      result.baselineWrite !== 0 ||
      result.candidateWrite !== 0,
  )
) {
  process.exitCode = 1;
}
