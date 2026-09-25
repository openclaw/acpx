import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalManager } from "../src/acp/terminal-manager.js";

for (const launch of ["explicit argv", "omitted-args shell command"] as const) {
  test(
    `Windows terminal ${launch} retains child stdout, stderr, and exit status`,
    { skip: process.platform !== "win32", timeout: 20_000 },
    async (t) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-output-"));
      const manager = new TerminalManager({
        cwd,
        permissionMode: "approve-all",
        killGraceMs: 200,
      });
      t.after(async () => {
        await manager.shutdown();
        await fs.rm(cwd, { recursive: true, force: true });
      });
      const scriptName = "terminal-output.cjs";
      await fs.writeFile(
        path.join(cwd, scriptName),
        [
          "process.stdout.write('terminal-stdout-marker\\n');",
          "process.stderr.write('terminal-stderr-marker\\n');",
          "process.exitCode = 23;",
        ].join("\n"),
      );
      const pathKey =
        Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path";
      const { terminalId } = await manager.createTerminal({
        sessionId: "output-fixture",
        ...(launch === "explicit argv"
          ? { command: process.execPath, args: [path.join(cwd, scriptName)] }
          : {
              command: `node.exe ${scriptName}`,
              env: [
                {
                  name: pathKey,
                  value: `${path.dirname(process.execPath)}${path.delimiter}${process.env[pathKey] ?? ""}`,
                },
              ],
            }),
      });
      const params = { sessionId: "output-fixture", terminalId };
      const exitStatus = await manager.waitForTerminalExit(params);
      assert.deepEqual(exitStatus, { exitCode: 23, signal: null });

      let output = await manager.terminalOutput(params);
      const deadline = performance.now() + 3_000;
      while (
        (!output.output.includes("terminal-stdout-marker") ||
          !output.output.includes("terminal-stderr-marker")) &&
        performance.now() < deadline
      ) {
        await delay(20);
        output = await manager.terminalOutput(params);
      }
      assert.deepEqual(output.output.trim().split(/\r?\n/u).toSorted(), [
        "terminal-stderr-marker",
        "terminal-stdout-marker",
      ]);
      assert.equal(output.truncated, false);
      assert.deepEqual(output.exitStatus, exitStatus);

      await manager.releaseTerminal(params);
      await assert.rejects(manager.terminalOutput(params), /Unknown terminal/u);
    },
  );
}
