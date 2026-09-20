import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withTempHome } from "./runtime-test-helpers.js";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/late-flow-preparation.js", import.meta.url));

for (const mode of ["isolated", "persistent"]) {
  for (const phase of ["cwd", "prompt"]) {
    for (const ending of ["timeout", "interrupt"]) {
      test(`${ending} revokes ${mode} ACP ${phase} preparation before its callback returns`, async () => {
        await withTempHome("acpx-flow-attempt-", async (home) => {
          const { stdout } = await exec(process.execPath, [fixture, home, mode, phase, ending], {
            cwd: home,
            env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: home },
            timeout: 15_000,
          });
          const result = JSON.parse(stdout) as {
            result: string;
            started: boolean;
            traceUnchanged: boolean;
          };
          assert.equal(result.result, ending === "timeout" ? "TimeoutError" : "InterruptedError");
          assert.equal(result.started, false, "expired preparation must not start an adapter");
          assert.equal(
            result.traceUnchanged,
            true,
            "late preparation must not publish trace events",
          );
        });
      });
    }
  }
}
