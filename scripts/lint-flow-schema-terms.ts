import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  "src/flows",
  "examples/flows/replay-viewer/src",
  "examples/flows/replay-viewer/public/sample-run",
  "examples/flows/pr-triage/pr-triage.flow.ts",
  "docs/2026-03-26-acpx-flow-trace-replay.md",
  "test/flows-store.test.ts",
  "test/flows.test.ts",
  "test/replay-viewer-run-bundles.test.ts",
  "test/replay-viewer-view-model.test.ts",
] as const;

const CHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".ndjson", ".md"]);

const BANNED_PATTERNS = [
  { label: "schema field `kind`", pattern: /\bkind\s*:/g },
  { label: 'JSON key `"kind"`', pattern: /"kind"\s*:/g },
  { label: "member access `.kind`", pattern: /\.kind\b/g },
  { label: "legacy flow field `currentNodeKind`", pattern: /\bcurrentNodeKind\b/g },
  { label: "legacy viewer field `sourceKind`", pattern: /\bsourceKind\b/g },
] as const;

type Violation = {
  filePath: string;
  line: number;
  label: string;
  excerpt: string;
};

const violations = collectViolations();

assert.equal(
  violations.length,
  0,
  [
    "Flow API and replay schemas must not use `kind` to mean type.",
    ...violations.map(
      (violation) =>
        `- ${violation.filePath}:${violation.line} ${violation.label} -> ${violation.excerpt}`,
    ),
  ].join("\n"),
);

function collectViolations(): Violation[] {
  const violations: Violation[] = [];

  for (const target of TARGETS) {
    const absoluteTarget = path.join(ROOT, target);
    if (!fs.existsSync(absoluteTarget)) {
      continue;
    }

    const stat = fs.statSync(absoluteTarget);
    if (stat.isDirectory()) {
      visitDirectory(absoluteTarget, violations);
      continue;
    }
    inspectFile(absoluteTarget, violations);
  }

  return violations;
}

function visitDirectory(directory: string, violations: Violation[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visitDirectory(absolutePath, violations);
      continue;
    }
    inspectFile(absolutePath, violations);
  }
}

function inspectFile(filePath: string, violations: Violation[]): void {
  if (!CHECKED_EXTENSIONS.has(path.extname(filePath))) {
    return;
  }

  const source = fs.readFileSync(filePath, "utf8");
  const relativePath = path.relative(ROOT, filePath);

  for (const { label, pattern } of BANNED_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      const excerpt = source.split("\n")[line - 1]?.trim() ?? "";
      violations.push({
        filePath: relativePath,
        line,
        label,
        excerpt,
      });
    }
  }
}
