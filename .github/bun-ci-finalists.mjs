import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const target = process.env.PROOF_TARGET;
const specs = {
  acpx: {
    manager: "pnpm",
    lock: "pnpm-lock.yaml",
    fixture: "src/bun-ci-proof-negative.ts",
    projects: { typecheck: [] },
    scripts: { typecheck: "typecheck", format: "format:check" },
    format: [],
    unused: true,
  },
  crabbox: {
    manager: "npm",
    lock: "package-lock.json",
    fixture: "src/bun-ci-proof-negative.ts",
    projects: { typecheck: [], nodecheck: ["--project", "tsconfig.node.json"] },
    scripts: { typecheck: "check", nodecheck: "check:node", format: "format:check" },
    format: ["."],
  },
  "agent-skills": {
    manager: "npm",
    lock: "package-lock.json",
    fixture: "skills/session-viewer/scripts/bun-ci-proof-negative.ts",
    projects: { typecheck: ["--project", "skills/session-viewer/tsconfig.json"] },
    scripts: { typecheck: "typecheck" },
  },
};
const spec = specs[target];
if (!spec) throw new Error("unknown proof target");
process.chdir(
  path.join(process.env.GITHUB_WORKSPACE, "source", target === "crabbox" ? "worker" : ""),
);
const bun = path.join(process.env.RUNNER_TEMP, "bun-ci-tools/bun-linux-x64/bun");
const results = [];
const parity = [];
const controls = [];
const originalManifest = fs.readFileSync("package.json", "utf8");
const manifest = JSON.parse(originalManifest);
const baseline = {};
const candidate = {};
const candidateScripts = {};
for (const [name, project] of Object.entries(spec.projects)) {
  baseline[name] = [
    path.resolve("node_modules/.bin/tsc"),
    ["--noEmit", "--pretty", "false", ...project],
  ];
  candidate[name] = [bun, ["check", "--no-script", "--no-pretty", ...project]];
  candidateScripts[name] = `bun check --no-script --no-pretty ${project.join(" ")}`.trim();
}
if (spec.format) {
  baseline.format = [path.resolve("node_modules/.bin/oxfmt"), ["--check", ...spec.format]];
  candidate.format = [bun, ["fmt", "--no-script", "--check", ...spec.format]];
  candidateScripts.format = `bun fmt --no-script --check ${spec.format.join(" ")}`.trim();
}

function run(label, command) {
  const started = performance.now();
  const child = spawnSync(command[0], command[1], {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", PATH: `${path.dirname(bun)}:${process.env.PATH}` },
  });
  const result = {
    label,
    milliseconds: performance.now() - started,
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    stdout: child.stdout?.slice(0, 18000),
    stderr: child.stderr?.slice(0, 18000),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  return result;
}

function packageScript(name, tool, label) {
  try {
    if (tool === "candidate") {
      const changed = {
        ...manifest,
        scripts: { ...manifest.scripts, [spec.scripts[name]]: candidateScripts[name] },
      };
      fs.writeFileSync("package.json", `${JSON.stringify(changed, null, 2)}\n`);
    }
    return run(label, [spec.manager, ["run", spec.scripts[name]]]);
  } finally {
    fs.writeFileSync("package.json", originalManifest);
  }
}

const head = run("source-head", ["git", ["rev-parse", "HEAD"]]).stdout.trim();
if (head !== process.env.PROOF_SOURCE_SHA)
  throw new Error("source head differs from frozen proof target");
run("node-version", ["node", ["--version"]]);
run("typescript-version", [baseline.typecheck[0], ["--version"]]);
run("bun-version", [bun, ["--revision"]]);
if (spec.format) run("oxfmt-version", [baseline.format[0], ["--version"]]);
for (const name of Object.keys(baseline)) {
  for (const tool of ["baseline", "candidate"])
    run(`${name}-${tool}-first`, (tool === "baseline" ? baseline : candidate)[name]);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const tool of repetition % 2 === 0
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      run(
        `${name}-${tool}-hot-${repetition + 1}`,
        (tool === "baseline" ? baseline : candidate)[name],
      );
      packageScript(name, tool, `${name}-${tool}-package-${repetition + 1}`);
    }
  }
}
if (target === "acpx") {
  const metadata = JSON.parse(
    fs.readFileSync("node_modules/@typescript/native/package.json", "utf8"),
  );
  const executable = path.resolve(
    "node_modules/@typescript/native",
    typeof metadata.bin === "string" ? metadata.bin : metadata.bin.tsc,
  );
  run("installed-native7-version", [executable, ["--version"]]);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const tool of repetition % 2 === 0 ? ["native7", "candidate"] : ["candidate", "native7"]) {
      run(
        `native7-comparison-${tool}-${repetition + 1}`,
        tool === "native7" ? [executable, ["--noEmit", "--pretty", "false"]] : candidate.typecheck,
      );
    }
  }
}

const typeControls = [
  ["assignment", 'export const invalid: number = "not a number";\n'],
  ["nullability", "export const invalid: string = null;\n"],
  ["implicit-any", "export function invalid(value) { return value; }\n"],
  ["property", "export const invalid = ({ value: 1 }).absent;\n"],
];
if (spec.unused)
  typeControls.push(
    ["unused-local", "const unused = 1;\nexport {};\n"],
    ["unused-parameter", "export function invalid(unused: string) { return 1; }\n"],
  );
if (target === "crabbox")
  typeControls.push(["indexed-access", "export const invalid: string = ([] as string[])[0];\n"]);
try {
  for (const [name, contents] of typeControls) {
    fs.writeFileSync(spec.fixture, contents);
    for (const category of Object.keys(spec.projects)) {
      const before = run(`negative-${category}-${name}-baseline`, baseline[category]);
      const after = run(`negative-${category}-${name}-candidate`, candidate[category]);
      controls.push({
        category,
        name,
        baseline: before.status,
        candidate: after.status,
        baselineCodes: [...new Set(before.stdout?.match(/TS\d+/g) ?? [])],
        candidateCodes: [...new Set(after.stdout?.match(/TS\d+/g) ?? [])],
      });
    }
  }
} finally {
  fs.rmSync(spec.fixture, { force: true });
}
if (spec.format) {
  const specimens = [
    ["ts", 'export const value={name:"hello",items:[1,2,3]}\n'],
    ["json", '{"value":1,"names":["one","two"]}\n'],
    ["md", "# title\n\n-   item\n"],
    ["yml", "name: proof\nitems: [one,two,three]\n"],
  ];
  for (const [extension, contents] of specimens) {
    const fixture = `bun-ci-proof-negative.${extension}`;
    try {
      fs.writeFileSync(fixture, contents);
      const before = run(`negative-format-${extension}-baseline`, [
        baseline.format[0],
        ["--check", fixture],
      ]);
      const after = run(`negative-format-${extension}-candidate`, [
        bun,
        ["fmt", "--no-script", "--check", fixture],
      ]);
      run(`write-${extension}-baseline`, [baseline.format[0], ["--write", fixture]]);
      const expected = fs.readFileSync(fixture, "utf8");
      fs.writeFileSync(fixture, contents);
      run(`write-${extension}-candidate`, [bun, ["fmt", "--no-script", fixture]]);
      const actual = fs.readFileSync(fixture, "utf8");
      run(`idempotence-${extension}-candidate`, [bun, ["fmt", "--no-script", fixture]]);
      parity.push({
        extension,
        baselineNegative: before.status,
        candidateNegative: after.status,
        equal: expected === actual,
        idempotent: actual === fs.readFileSync(fixture, "utf8"),
        expected,
        actual,
      });
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  }
}
const report = {
  target,
  head,
  mode: process.env.PROOF_MODE,
  runner: {
    platform: process.platform,
    architecture: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0].model,
    release: os.release(),
  },
  lockfile: createHash("sha256").update(fs.readFileSync(spec.lock)).digest("hex"),
  results,
  controls,
  parity,
  caveats: [
    "first invocation follows install, not OS-cold",
    "core timings exclude package launcher; package timings use the same manager on both sides",
    "same locked dependencies retained; candidate-only Bun provisioning and cache overhead are separate job steps",
  ],
};
console.log(`BUN_CI_FINALISTS_JSON=${JSON.stringify(report)}`);
const valid = results.filter((result) =>
  /^(typecheck|nodecheck|format)-(baseline|candidate)-(first|hot|package)/.test(result.label),
);
if (
  valid.some((result) => result.status !== 0) ||
  controls.some(
    (control) =>
      control.baseline === 0 ||
      control.candidate === 0 ||
      JSON.stringify(control.baselineCodes) !== JSON.stringify(control.candidateCodes),
  ) ||
  parity.some((sample) => !sample.equal || !sample.idempotent)
)
  process.exitCode = 1;
