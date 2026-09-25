import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReplayViewerServer,
  type ReplayViewerServer,
} from "../examples/flows/replay-viewer/server/viewer-server.js";

for (const disabled of [true, false, undefined]) {
  test(
    `viewer dependency optimization honors ${String(disabled)}`,
    { timeout: 45_000 },
    async () => {
      const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-viewer-optimization-"));
      let viewer: ReplayViewerServer | undefined;
      try {
        viewer = await createReplayViewerServer({
          host: "127.0.0.1",
          port: 0,
          runsDir,
          ...(disabled === undefined ? {} : { disableDependencyOptimization: disabled }),
        });
        const { baseUrl } = viewer;
        const response = await fetch(new URL("/src/main.tsx", baseUrl), {
          headers: { Origin: baseUrl },
          signal: AbortSignal.timeout(30_000),
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(body.includes("createRoot"), "the actual viewer entry must be transformed");
        assert.equal(body.includes("<StrictMode>"), false, "TSX must still compile to JavaScript");
        assert.equal(
          body.includes("/.vite/deps/"),
          disabled !== true,
          "the disabled option must suppress explicit React optimization as well as discovery",
        );
        const optimizedImports = [...body.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
          .map((match) => match[1] ?? "")
          .filter((specifier) => specifier.includes("/.vite/deps/"));
        // Complete the module requests before shutting down the development server.
        await Promise.all(
          optimizedImports.map(async (specifier) => {
            const dependency = await fetch(new URL(specifier, baseUrl), {
              signal: AbortSignal.timeout(30_000),
            });
            assert.equal(dependency.status, 200);
            assert.ok((await dependency.text()).length > 0);
          }),
        );
      } finally {
        await viewer?.close();
        await fs.rm(runsDir, { recursive: true, force: true });
      }
    },
  );
}
