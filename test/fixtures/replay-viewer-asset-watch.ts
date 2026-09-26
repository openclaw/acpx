import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ViteDevServer } from "vite";
import {
  createReplayViewerServer,
  fetchViewerServerHealth,
} from "../../examples/flows/replay-viewer/server/viewer-server.js";

const execFileAsync = promisify(execFile);
const viewerCliPath = fileURLToPath(
  new URL("../../examples/flows/replay-viewer/server.js", import.meta.url),
);

type FixtureGlobal = typeof globalThis & {
  acpxAssetWatchFixture?: ViteDevServer["watcher"];
};

const fixtureRoot = process.argv[2];
assert.ok(fixtureRoot);
assert.equal(process.cwd(), fixtureRoot);
const frontendRoot = path.join(fixtureRoot, "frontend");
const runsDir = path.join(fixtureRoot, "runs");
const configDir = path.join(fixtureRoot, "examples", "flows", "replay-viewer");
const editedAssetPath = path.join(frontendRoot, "edited.ts");
const replacedAssetPath = path.join(frontendRoot, "replaced.ts");
await fs.mkdir(frontendRoot, { recursive: true });
await fs.mkdir(runsDir);
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}\n');
await fs.writeFile(editedAssetPath, assetSource("watch-initial-value"));
await fs.writeFile(replacedAssetPath, assetSource("watch-initial-value"));
// Compiled viewer code discovers this task-owned config from its child cwd.
await fs.writeFile(
  path.join(configDir, "vite.config.ts"),
  `export default {
    root: ${JSON.stringify(frontendRoot)},
    plugins: [{
      name: "acpx-asset-watch-fixture",
      configureServer(server) {
        globalThis.acpxAssetWatchFixture = server.watcher;
      },
    }],
  };\n`,
);

const fixtureGlobal = globalThis as FixtureGlobal;
const viewer = await createReplayViewerServer({
  host: "127.0.0.1",
  port: 0,
  runsDir,
  disableDependencyOptimization: true,
});

try {
  const watcher = fixtureGlobal.acpxAssetWatchFixture;
  assert.ok(watcher, "the temporary Vite config must own this server");
  await waitFor(() => {
    const watched = watcher.getWatched()[frontendRoot] ?? [];
    return [editedAssetPath, replacedAssetPath].every((asset) =>
      watched.includes(path.basename(asset)),
    );
  }, "the fixture assets to be watched");
  assert.deepEqual(await fetchViewerServerHealth(viewer.baseUrl), {
    service: "acpx-flow-replay-viewer",
    runsDir,
  });
  const editedAssetUrl = new URL("/edited.ts", viewer.baseUrl);
  const replacedAssetUrl = new URL("/replaced.ts", viewer.baseUrl);
  await expectAsset(editedAssetUrl, "watch-initial-value");
  await expectAsset(replacedAssetUrl, "watch-initial-value");

  await fs.writeFile(editedAssetPath, assetSource("watch-in-place-value"));
  await expectAsset(editedAssetUrl, "watch-in-place-value");

  // Repeated replacements expose watchers that remain attached to the old inode.
  for (const marker of ["watch-first-atomic-value", "watch-atomic-value"]) {
    const replacement = path.join(frontendRoot, "replacement.ts");
    await fs.writeFile(replacement, assetSource(marker));
    await fs.rename(replacement, replacedAssetPath);
    await expectAsset(replacedAssetUrl, marker);
  }

  // Keep the control client's deadline on its own event loop during server teardown.
  const stopped = await execFileAsync(process.execPath, [
    viewerCliPath,
    "stop",
    "--host",
    "127.0.0.1",
    "--port",
    String(viewer.port),
    "--runs-dir",
    runsDir,
  ]);
  assert.equal(stopped.stdout, `Stopped viewer at ${viewer.baseUrl}/\n`);
  await viewer.close();
  process.stdout.write(
    `ASSET_WATCH_RESULT ${JSON.stringify({
      initial: "watch-initial-value",
      edited: "watch-in-place-value",
      replaced: "watch-atomic-value",
      health: true,
      shutdown: true,
    })}\n`,
  );
} finally {
  delete fixtureGlobal.acpxAssetWatchFixture;
  await viewer.close();
}

function assetSource(marker: string): string {
  return `export const marker: string = ${JSON.stringify(marker)};\n`;
}

async function expectAsset(url: URL, marker: string): Promise<void> {
  // Keep the same URL: cache-busting would avoid the invalidation being tested.
  await waitFor(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(": string"), false, "Vite must transform the TypeScript asset");
    return body.includes(JSON.stringify(marker));
  }, `transformed content for ${marker}`);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}
