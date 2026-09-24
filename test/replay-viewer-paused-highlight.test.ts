import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const fixture = path.resolve("test/fixtures/replay-viewer-paused-highlight.mjs");
const tsconfig = path.resolve("examples/flows/replay-viewer/tsconfig.json");

for (const scenario of [
  "first-second-back",
  "non-acp-fallback",
  "unrelated-no-range",
  "tool-only",
]) {
  test(`paused ACP conversation identifies its selected slice: ${scenario}`, async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", fixture, scenario],
      {
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    const result = JSON.parse(stdout) as { scenario: string; ok: boolean };
    assert.equal(result.scenario, scenario);
    assert.equal(result.ok, true);
  });
}
