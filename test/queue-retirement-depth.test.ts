// Synthetic Windows-shaped receipt data on POSIX is not native Windows cleanup proof.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  readQueueOwnerRecord,
  tryAcquireQueueOwnerLease,
} from "../src/session/queue/lease-store.js";
import { queueSocketBaseDir } from "../src/session/queue/paths.js";
import { parseQueueRetirementReceipt } from "../src/session/queue/retirement-receipt.js";
import { queuePaths, withTempHome } from "./queue-test-helpers.js";

const birth = { kind: "windows-creation" as const, value: "2026-09-21T10:00:00.0000000Z" };

for (const surface of ["parser", "owner read", "aged collision"] as const) {
  test(
    `deep retirement receipt retains custody through ${surface}`,
    { skip: process.platform === "win32" },
    async (t) => {
      await withTempHome(async (homeDir) => {
        const sessionId = "retirement-depth";
        const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
        const owner = { pid: process.pid, ownerGeneration: 17, processIdentity: birth };
        assert(owner.pid > 1 && owner.pid !== 2_147_483_647);
        const receipt = {
          ownerGeneration: owner.ownerGeneration,
          root: { pid: owner.pid, processIdentity: birth },
          descendants: [{ pid: 2_147_483_647, processIdentity: birth }],
        };
        const shallow = JSON.stringify(receipt);
        const rawReceipt = `${shallow.slice(0, -1)},"padding":${"[".repeat(200_000)}0${"]".repeat(200_000)}}`;
        assert(Buffer.byteLength(rawReceipt, "utf8") < 1024 * 1024);
        const raw: unknown = JSON.parse(rawReceipt);
        let expected: typeof receipt | null = receipt;
        try {
          JSON.stringify(raw);
        } catch {
          expected = null;
        }

        const record = JSON.stringify({
          ...owner,
          sessionId,
          socketPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          heartbeatAt: "2000-01-01T00:00:00.000Z",
          queueDepth: 0,
        });
        const original = `${record.slice(0, -1)},"retirement":${rawReceipt}}\n`;
        assert(Buffer.byteLength(original, "utf8") < 1024 * 1024);
        await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(lockPath, original, { flag: "wx", mode: 0o600 });
        await fs.utimes(lockPath, 0, 0);
        try {
          if (surface === "parser") {
            t.diagnostic(
              `Natural sizing ${expected === null ? "threw" : "succeeded"}; no injection`,
            );
            let parsed: ReturnType<typeof parseQueueRetirementReceipt> | undefined;
            assert.doesNotThrow(() => {
              parsed = parseQueueRetirementReceipt(raw, owner);
            });
            assert.deepEqual(parsed, expected);
          } else if (surface === "owner read") {
            const observed = await readQueueOwnerRecord(sessionId);
            assert(observed, "receipt sizing failure must not hide the owner");
            assert.equal(observed.pid, process.pid);
            assert.equal(observed.ownerGeneration, owner.ownerGeneration);
            assert.deepEqual(observed.retirement, expected);
          } else {
            // Present valid or invalid custody reaches the self-PID refusal before signaling.
            await assert.rejects(tryAcquireQueueOwnerLease(sessionId), {
              detailCode: "QUEUE_OWNER_RETIREMENT_INCOMPLETE",
            });
          }
          assert.equal(await fs.readFile(lockPath, "utf8"), original);
        } finally {
          // Acquisition can create this empty task-owned directory outside the private home.
          const socketDir = queueSocketBaseDir(homeDir);
          if (socketDir) {
            await fs.rmdir(socketDir).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") {
                throw error;
              }
            });
          }
        }
      });
    },
  );
}
