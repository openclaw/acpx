import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI = path.resolve("dist/cli.js");
const AGENT = fileURLToPath(new URL("./fixtures/reused-session-agent.js", import.meta.url));

for (const extension of ["mjs", "cjs", "ts", "mts", "cts"]) {
  test(`flow loader resolves helper imports without rewriting data or writing beside ${extension} sources`, async () => {
    await withTempHome("acpx-flow-module-", async (home) => {
      const sourceDir = path.join(home, "readonly");
      await fs.mkdir(sourceDir);
      const helper = path.join(sourceDir, `helper.${extension}`);
      const entry = path.join(sourceDir, `entry.${extension}`);
      const commonjs = extension === "cjs" || extension === "cts";
      await fs.writeFile(
        helper,
        commonjs
          ? 'const {compute} = require("acpx/flows"); exports.node = compute({run: () => "acpx/flows"});'
          : 'import {compute} from "acpx/flows"; export const node = compute({run: () => "acpx/flows"});',
      );
      await fs.writeFile(
        entry,
        commonjs
          ? `const {defineFlow} = require("acpx/flows"); const {node} = require("./helper.${extension}"); module.exports = defineFlow({name:"loader",startAt:"ask",nodes:{ask:node},edges:[]});`
          : `import {defineFlow} from "acpx/flows"; import {node} from "./helper.${extension}"; export default defineFlow({name:"loader",startAt:"ask",nodes:{ask:node},edges:[]});`,
      );
      await fs.chmod(sourceDir, 0o555);
      try {
        const result = spawnSync(
          process.execPath,
          [CLI, "--format", "json", "flow", "run", entry],
          {
            cwd: home,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, HOME: home, USERPROFILE: home },
          },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout.trim()) as { outputs: { ask: string } };
        assert.equal(output.outputs.ask, "acpx/flows");
        assert.deepEqual((await fs.readdir(sourceDir)).toSorted(), [
          `entry.${extension}`,
          `helper.${extension}`,
        ]);
      } finally {
        await fs.chmod(sourceDir, 0o755);
      }
    });
  });
}

for (const flag of ["--system-prompt", "--append-system-prompt"]) {
  for (const isolated of [false, true]) {
    test(`flow ${flag} reaches ${isolated ? "isolated" : "persistent"} ACP session creation`, async () => {
      await withTempHome("acpx-flow-system-prompt-", async (home) => {
        const entry = path.join(home, "prompt.mjs");
        const receipt = path.join(home, "new-session.json");
        await fs.writeFile(
          entry,
          `import {defineFlow, acp} from "acpx/flows";
          export default defineFlow({name:"system",startAt:"ask",nodes:{ask:acp({session:{isolated:${isolated}},prompt:()=>"echo hi"})},edges:[]});`,
        );
        const result = spawnSync(
          process.execPath,
          [
            CLI,
            "--cwd",
            home,
            "--agent",
            `${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT)} ${JSON.stringify(receipt)}`,
            flag,
            "Be precise",
            "--format",
            "json",
            "flow",
            "run",
            entry,
          ],
          {
            cwd: home,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, HOME: home, USERPROFILE: home },
          },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const params = JSON.parse(await fs.readFile(receipt, "utf8")) as {
          _meta?: { systemPrompt?: unknown };
        };
        assert.deepEqual(
          params._meta?.systemPrompt,
          flag === "--system-prompt" ? "Be precise" : { append: "Be precise" },
        );
        const output = JSON.parse(result.stdout.trim()) as { runDir: string };
        const sessions = path.join(output.runDir, "sessions");
        const [bundle] = await fs.readdir(sessions);
        const record = JSON.parse(
          await fs.readFile(path.join(sessions, bundle, "record.json"), "utf8"),
        ) as { acpSessionId: string; acpxRecordId: string };
        assert.equal(record.acpSessionId, "synthetic-flow-session");
        if (!isolated) {
          assert.notEqual(record.acpxRecordId, record.acpSessionId);
        }
      });
    });
  }
}
