import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(
  new URL("./fixtures/replay-viewer-asset-watch.js", import.meta.url),
);

test("replay viewer invalidates transformed assets after edits and atomic replacement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-asset-watch-"));
  const fixtureRoot = await fs.realpath(directory);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [fixturePath, fixtureRoot], {
      cwd: fixtureRoot,
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    const result = stdout.split("\n").find((line) => line.startsWith("ASSET_WATCH_RESULT "));
    assert.ok(result, `${stdout}\n${stderr}`);
    assert.deepEqual(JSON.parse(result.slice("ASSET_WATCH_RESULT ".length)), {
      initial: "watch-initial-value",
      edited: "watch-in-place-value",
      replaced: "watch-atomic-value",
      health: true,
      shutdown: true,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
