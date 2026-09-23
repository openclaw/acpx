import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const fixture = path.resolve("test/fixtures/replay-viewer-keyboard.mjs");
const tsconfig = path.resolve("examples/flows/replay-viewer/tsconfig.json");

for (const scenario of [
  "right-taps",
  "left-taps",
  "vertical-arrows",
  "repeated-keydown",
  "playback-origin",
  "non-seeking-keyup",
  "seek-origin",
  "page-seek-keys",
  "pointer-home-end-blur",
  "modifier-keyup",
  "empty-single",
]) {
  test(`replay scrubber component and playback hook: ${scenario}`, async () => {
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
