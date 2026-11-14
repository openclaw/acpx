import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { exportSession } from "../src/session/export.js";
import { SessionJournalReader } from "../src/session/journal.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

for (const change of ["provider", "checkpoint", "removed", "owner"] as const) {
  for (const existingOutput of [false, true]) {
    test(
      "export rejects " + change + " during capture; existing output: " + existingOutput,
      async (t) => {
        await withTempHome("acpx-export-snapshot-", async (home) => {
          const record = makeSessionRecord({
            acpxRecordId: "export-snapshot",
            acpSessionId: "provider-before",
            agentCommand: "synthetic-agent",
            cwd: home,
          });
          await writeSessionRecordFile(home, record);
          const output = path.join(home, "archive.json");
          if (existingOutput) {
            await fs.writeFile(output, "previous archive");
          }
          const read = SessionJournalReader.prototype.readAcpMessages;
          t.mock.method(
            SessionJournalReader.prototype,
            "readAcpMessages",
            async function (this: SessionJournalReader) {
              const history = await read.call(this);
              if (change === "removed") {
                await fs.unlink(sessionFilePath(home, record.acpxRecordId));
              } else if (change === "owner") {
                const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                  stdio: "ignore",
                });
                const exited = once(child, "exit");
                t.after(async () => {
                  child.kill();
                  await exited;
                });
                assert.ok(child.pid);
                await fs.writeFile(
                  path.join(home, ".acpx", "sessions", record.acpxRecordId + ".stream.lock"),
                  JSON.stringify({ pid: child.pid }),
                );
              } else {
                if (change === "provider") {
                  record.acpSessionId = "provider-after";
                } else {
                  record.lastSeq += 1;
                }
                await writeSessionRecordFile(home, record);
              }
              return history;
            },
          );
          await assert.rejects(
            exportSession(
              { agentCommand: record.agentCommand, cwd: home, name: record.name },
              output,
            ),
            (error: unknown) => {
              assert.equal((error as { code?: unknown }).code, "session-locked");
              assert.equal((error as { exitCode?: unknown }).exitCode, 2);
              return true;
            },
          );
          if (existingOutput) {
            assert.equal(await fs.readFile(output, "utf8"), "previous archive");
          } else {
            await assert.rejects(fs.access(output), { code: "ENOENT" });
          }
        });
      },
    );
  }
}
