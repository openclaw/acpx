import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { resolveQueueOwnerMainPath } from "../src/session-runtime/queue-owner-process.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acpx-queue-owner-path-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveQueueOwnerMainPath", () => {
  it("resolves ../queue-owner-main.js when present", async () => {
    await withTempDir(async (dir) => {
      const sessionRuntimeDir = path.join(dir, "dist-test", "src", "session-runtime");
      const queueOwnerMainPath = path.join(
        dir,
        "dist-test",
        "src",
        "queue-owner-main.js",
      );
      await mkdir(sessionRuntimeDir, { recursive: true });
      await writeFile(queueOwnerMainPath, "// stub\n", "utf8");
      const base = pathToFileURL(
        path.join(sessionRuntimeDir, "queue-owner-process.js"),
      ).href;

      const resolved = resolveQueueOwnerMainPath(base);
      assert.equal(resolved, queueOwnerMainPath);
    });
  });

  it("falls back to ./queue-owner-main.js for bundled dist chunks", async () => {
    await withTempDir(async (dir) => {
      const distDir = path.join(dir, "dist");
      const queueOwnerMainPath = path.join(distDir, "queue-owner-main.js");
      await mkdir(distDir, { recursive: true });
      await writeFile(queueOwnerMainPath, "// stub\n", "utf8");
      const base = pathToFileURL(path.join(distDir, "chunk-abc.js")).href;

      const resolved = resolveQueueOwnerMainPath(base);
      assert.equal(resolved, queueOwnerMainPath);
    });
  });
});
