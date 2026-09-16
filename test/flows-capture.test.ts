import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { FlowRunState } from "../src/flows/types.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT = fileURLToPath(new URL("./fixtures/flow-capture-agent.js", import.meta.url));

for (const isolated of [false, true]) {
  for (const fail of [false, true]) {
    test(`flow capture settles writes for ${isolated ? "isolated" : "persistent"} prompt ${fail ? "failure" : "success"}`, async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-capture-"));
      const outputRoot = path.join(home, ".acpx", "flows", "runs");
      const readyPath = path.join(home, "ready");
      const releasePath = path.join(home, "release");
      const fixture = path.join(home, "capture.flow.mjs");
      await fs.writeFile(
        fixture,
        `
        import path from "node:path";
        import { defineFlow, acp } from "acpx/flows";
        export default defineFlow({
          name: "capture-proof", startAt: "capture",
          nodes: { capture: acp({
            session: { isolated: ${isolated} },
            prompt: ({ state, input }) => JSON.stringify({
              ...input, runDir: path.join(input.outputRoot, state.runId),
            }),
          }) }, edges: [],
        });
      `,
      );
      let stdout = "";
      let stderr = "";
      let exited = false;
      const child = spawn(
        process.execPath,
        [
          "--unhandled-rejections=strict",
          CLI,
          "--cwd",
          home,
          "--agent",
          `${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT)}`,
          "--deny-all",
          "--format",
          "json",
          "flow",
          "run",
          fixture,
          "--input-json",
          JSON.stringify({ outputRoot, readyPath, releasePath, fail }),
        ],
        {
          cwd: home,
          env: { HOME: home, TMPDIR: home, PATH: process.env.PATH },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          exited = true;
          resolve(code);
        });
      });
      const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
      try {
        const deadline = Date.now() + 10_000;
        while (!(await fs.stat(readyPath).catch(() => undefined))) {
          assert.equal(exited, false, stderr || stdout);
          assert.ok(Date.now() < deadline, "capture fixture did not reach the prompt");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(exited, false, stderr || stdout);
        await fs.writeFile(releasePath, "release");
        assert.equal(await exit, 1);
        const [runId] = await fs.readdir(outputRoot);
        const state = JSON.parse(
          await fs.readFile(path.join(outputRoot, runId, "projections", "run.json"), "utf8"),
        ) as FlowRunState;
        assert.equal(state.status, "failed");
        assert.equal(state.results.capture.outcome, "failed");
        assert.deepEqual(state.outputs, {});
        if (fail) {
          assert.equal(state.error, "DISTINCTIVE_PROMPT_FAILURE");
          assert.match(stdout, /DISTINCTIVE_PROMPT_FAILURE/);
        } else {
          assert.match(state.error ?? "", /Refusing to append/);
          assert.match(stdout, /Refusing to append/);
        }
        assert.doesNotMatch(stderr, /Node\.js v/);
      } finally {
        clearTimeout(timeout);
        if (!exited) {
          await fs.writeFile(releasePath, "release");
          child.kill("SIGTERM");
          await exit;
        }
        await fs.rm(home, { recursive: true, force: true });
      }
    });
  }
}
