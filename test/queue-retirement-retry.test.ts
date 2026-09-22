import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, test } from "node:test";
import { readQueueOwnerRecord } from "../src/session/queue/lease-store.js";
import {
  runRetirer,
  startWitnessedTree,
  stopWitnesses,
  witnessStates,
} from "./fixtures/queue-retirement-retry.js";
import { queuePaths, withTempHome, writeQueueOwnerLock } from "./queue-test-helpers.js";

describe(
  "Windows retirement receipts across independent processes",
  { skip: process.platform !== "win32" },
  () => {
    for (const mode of ["partial", "partial-settlement"] as const) {
      test(`${mode} keeps a detached survivor recoverable after the first retirer exits`, async () => {
        await withTempHome(async (home) => {
          const sessionId = `retirement-retry-${mode}`;
          const tree = await startWitnessedTree();
          const [root, bridge, leaf] = tree.witnesses;
          assert(root && bridge && leaf);
          let first;
          let beforeRetry;
          let second;
          let afterRetry;
          try {
            await writeQueueOwnerLock({ ...queuePaths(home, sessionId), sessionId, ...root });
            first = await runRetirer(mode, sessionId);
            assert.equal(
              first.code,
              mode === "partial" ? 23 : "QUEUE_LEASE_GUARD_SETTLEMENT_FAILED",
            );
            beforeRetry = await witnessStates(tree.witnesses);
            assert.deepEqual(beforeRetry, ["gone", "gone", "matching"]);
            assert(await readQueueOwnerRecord(sessionId), "partial cleanup retains the lease");
            // This process imports no state from the first retirer. Its only authority is disk.
            second = await runRetirer("retry", sessionId);
            afterRetry = await witnessStates(tree.witnesses);
            assert.deepEqual(
              afterRetry,
              ["gone", "gone", "gone"],
              "a fresh retirer must finish the witnessed detached leaf",
            );
            assert.equal(second.code, undefined);
            assert.equal(await readQueueOwnerRecord(sessionId), undefined);
            assert.deepEqual(
              first.receiptWitnesses.toSorted((a, b) => a.pid - b.pid),
              tree.expectedWitnesses
                .filter((witness) => witness.pid !== root.pid)
                .toSorted((a, b) => a.pid - b.pid),
            );
            assert.deepEqual(
              await witnessStates(tree.expectedWitnesses),
              tree.expectedWitnesses.map(() => "gone"),
            );
          } finally {
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
            // Bounded direct evidence is emitted even when the baseline assertion fails.
            process.stdout.write(
              `${JSON.stringify({
                mode,
                first,
                beforeRetry,
                second,
                afterRetry,
                expectedWitnesses: tree.expectedWitnesses,
                cleanup: await witnessStates(tree.expectedWitnesses),
              })}\n`,
            );
          }
        });
      });
    }

    for (const mode of ["write-failure", "query-failure"] as const) {
      test(`${mode} refuses before destructive tree dispatch`, async () => {
        await withTempHome(async (home) => {
          const sessionId = `retirement-${mode}`;
          const tree = await startWitnessedTree();
          try {
            const paths = queuePaths(home, sessionId);
            await writeQueueOwnerLock({
              ...paths,
              sessionId,
              ...tree.witnesses[0],
              heartbeatAt: "2000-01-01T00:00:00.000Z",
            });
            const original = await fs.readFile(paths.lockPath, "utf8");
            const result = await runRetirer(mode, sessionId);
            assert.equal(
              result.code,
              mode === "write-failure" ? "EIO" : "QUEUE_OWNER_IDENTITY_UNVERIFIED",
            );
            assert.equal(result.taskkillCalls, 0);
            assert.deepEqual(await witnessStates(tree.witnesses), [
              "matching",
              "matching",
              "matching",
            ]);
            assert.equal(await fs.readFile(paths.lockPath, "utf8"), original);
          } finally {
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
            process.stdout.write(
              `${JSON.stringify({ mode, cleanup: await witnessStates(tree.expectedWitnesses) })}\n`,
            );
          }
        });
      });
    }

    for (const mode of ["success-survivor", "success-stalled"] as const) {
      test(`${mode} verifies completion independently of taskkill exit status`, async () => {
        await withTempHome(async (home) => {
          const sessionId = mode;
          const tree = await startWitnessedTree();
          try {
            await writeQueueOwnerLock({
              ...queuePaths(home, sessionId),
              sessionId,
              ...tree.witnesses[0],
            });
            const started = performance.now();
            const result = await runRetirer(mode, sessionId);
            assert(
              performance.now() - started < 12_000,
              "wall-clock rollback cannot extend cleanup indefinitely",
            );
            const stalled = mode === "success-stalled";
            if (stalled) {
              assert(
                ["QUEUE_OWNER_RETIREMENT_INCOMPLETE", "ETIMEDOUT"].includes(String(result.code)),
              );
              assert(result.taskkillCalls > 0);
            } else {
              assert.equal(result.code, undefined);
            }
            assert.deepEqual(
              await witnessStates(tree.witnesses),
              tree.witnesses.map(() => (stalled ? "matching" : "gone")),
            );
            assert.deepEqual(
              await witnessStates(tree.expectedWitnesses),
              tree.expectedWitnesses.map(() => (stalled ? "matching" : "gone")),
            );
            const saved = await readQueueOwnerRecord(sessionId);
            assert.equal(saved !== undefined && Object.hasOwn(saved, "retirement"), stalled);
          } finally {
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
          }
        });
      });
    }

    test("an unverified saved descendant keeps its receipt for a later independent retry", async () => {
      await withTempHome(async (home) => {
        const sessionId = "retirement-unknown-saved";
        const tree = await startWitnessedTree();
        try {
          const paths = queuePaths(home, sessionId);
          await writeQueueOwnerLock({ ...paths, sessionId, ...tree.witnesses[0] });
          assert.equal((await runRetirer("partial", sessionId)).code, 23);
          const pending = await fs.readFile(paths.lockPath, "utf8");
          const unknown = await runRetirer("query-failure", sessionId);
          assert.equal(unknown.code, "QUEUE_OWNER_RETIREMENT_INCOMPLETE");
          assert.equal(unknown.taskkillCalls, 0);
          assert.deepEqual(await witnessStates(tree.witnesses), ["gone", "gone", "matching"]);
          assert.equal(await fs.readFile(paths.lockPath, "utf8"), pending);
          assert.equal((await runRetirer("retry", sessionId)).code, undefined);
          assert.deepEqual(await witnessStates(tree.witnesses), ["gone", "gone", "gone"]);
          assert.deepEqual(
            await witnessStates(tree.expectedWitnesses),
            tree.expectedWitnesses.map(() => "gone"),
          );
        } finally {
          await stopWitnesses(tree.expectedWitnesses);
          await tree.closed;
        }
      });
    });

    test("slow identity queries make progress across bounded cleanup attempts", async () => {
      await withTempHome(async (home) => {
        const sessionId = "retirement-slow-progress";
        const tree = await startWitnessedTree(4);
        const started = performance.now();
        const progress: number[] = [4];
        try {
          await writeQueueOwnerLock({
            ...queuePaths(home, sessionId),
            sessionId,
            ...tree.witnesses[0],
          });
          assert.equal((await runRetirer("partial", sessionId)).code, 23);
          for (let attempt = 0; attempt < 4 && progress.at(-1)! > 0; attempt += 1) {
            const result = await runRetirer("slow-retry", sessionId);
            const remaining = (await witnessStates(tree.witnesses.slice(2))).filter(
              (state) => state === "matching",
            ).length;
            assert(
              remaining < progress.at(-1)!,
              "each bounded attempt must retire a verified member",
            );
            progress.push(remaining);
            if (remaining > 0) {
              assert.equal(result.code, "QUEUE_OWNER_RETIREMENT_INCOMPLETE");
              assert(await readQueueOwnerRecord(sessionId));
            } else {
              assert.equal(result.code, undefined);
              assert.equal(await readQueueOwnerRecord(sessionId), undefined);
            }
          }
          assert.equal(progress.at(-1), 0);
          assert.deepEqual(
            await witnessStates(tree.expectedWitnesses),
            tree.expectedWitnesses.map(() => "gone"),
          );
          assert(
            performance.now() - started < 40_000,
            "cleanup must precede fixture lifetime expiry",
          );
        } finally {
          await stopWitnesses(tree.expectedWitnesses);
          await tree.closed;
          process.stdout.write(
            `${JSON.stringify({ progress, cleanup: await witnessStates(tree.expectedWitnesses) })}\n`,
          );
        }
      });
    });

    test("new descendant custody must publish before any saved member is signaled", async () => {
      await withTempHome(async (home) => {
        const sessionId = "retirement-new-custody-publication";
        const tree = await startWitnessedTree();
        const [root, bridge, leaf] = tree.witnesses;
        assert(root && bridge && leaf);
        try {
          const paths = queuePaths(home, sessionId);
          const savedRoot = {
            ...root,
            processIdentity: {
              kind: "windows-creation" as const,
              value: "2000-01-01T00:00:00.0000000Z",
            },
          };
          await writeQueueOwnerLock({ ...paths, sessionId, ...savedRoot });
          const owner = await readQueueOwnerRecord(sessionId);
          assert(owner);
          const original = JSON.stringify({
            ...owner,
            retirement: {
              ownerGeneration: owner.ownerGeneration,
              root: savedRoot,
              descendants: [bridge],
            },
          });
          await fs.writeFile(paths.lockPath, original);
          // The saved bridge discovers a previously unrecorded leaf. Neither
          // member may be signaled when that new custody cannot be published.
          const refused = await runRetirer("write-failure", sessionId);
          assert.equal(refused.code, "EIO");
          assert.equal(refused.taskkillCalls, 0);
          assert.equal(refused.signalReceiptWitnesses, undefined);
          assert.equal(refused.publishedReceiptWitnesses, undefined);
          assert.equal(await fs.readFile(paths.lockPath, "utf8"), original);
          assert.deepEqual(await witnessStates(tree.witnesses), [
            "matching",
            "matching",
            "matching",
          ]);
        } finally {
          await stopWitnesses(tree.expectedWitnesses);
          await tree.closed;
        }
      });
    });

    test("live reused PIDs cannot starve a later saved survivor across slow retries", async () => {
      await withTempHome(async (home) => {
        const sessionId = "retirement-reused-progress";
        const tree = await startWitnessedTree();
        const trees = [tree];
        const attempts: Awaited<ReturnType<typeof runRetirer>>[] = [];
        const progress: string[][] = [];
        let cleanup: PromiseSettledResult<void>[] = [];
        try {
          // These live actors belong to a separate tree, not the retired owner.
          // Persist older births to reproduce PID reuse without churning PIDs.
          const replacements = await startWitnessedTree(0);
          trees.push(replacements);
          const paths = queuePaths(home, sessionId);
          await writeQueueOwnerLock({ ...paths, sessionId, ...tree.witnesses[0] });
          assert.equal((await runRetirer("partial", sessionId)).code, 23);
          const pending = await readQueueOwnerRecord(sessionId);
          assert(pending?.retirement);
          const replaced = replacements.witnesses.map((witness) => ({
            ...witness,
            processIdentity: {
              kind: "windows-creation" as const,
              value: "2000-01-01T00:00:00.0000000Z",
            },
          }));
          const original = JSON.stringify({
            ...pending,
            retirement: {
              ...pending.retirement,
              descendants: [...replaced, ...pending.retirement.descendants],
            },
          });
          await fs.writeFile(paths.lockPath, original);

          for (
            let attempt = 0;
            attempt < 2 && (await readQueueOwnerRecord(sessionId));
            attempt += 1
          ) {
            attempts.push(await runRetirer("slow-retry", sessionId));
            progress.push(await witnessStates(tree.witnesses));
          }
          assert.deepEqual(
            progress.at(-1),
            ["gone", "gone", "gone"],
            "fresh retries must reach the survivor after the live replacement prefix",
          );
          assert.equal(attempts.at(-1)?.code, undefined);
          assert.equal(await readQueueOwnerRecord(sessionId), undefined);
          const duringSignal = attempts[0]?.signalReceiptWitnesses;
          assert(duringSignal);
          assert(duringSignal.some((witness) => witness.pid === tree.witnesses[2].pid));
          // Already-persisted custody can remain on disk through the batch.
          // Pruning stale births need not add an I/O gap before a verified signal.
          assert(replaced.every((old) => duringSignal.some((witness) => witness.pid === old.pid)));
          assert.deepEqual(
            await witnessStates(replacements.expectedWitnesses),
            replacements.expectedWitnesses.map(() => "matching"),
          );
        } finally {
          // Cleanup authority comes from each independently observed fixture tree,
          // never from the deliberately stale retirement receipt.
          cleanup = await Promise.allSettled(
            trees.map(async (owned) => {
              try {
                await stopWitnesses(owned.expectedWitnesses);
              } finally {
                await owned.closed;
              }
            }),
          );
          process.stdout.write(
            `${JSON.stringify({
              mode: "reused-progress",
              attempts,
              progress,
              cleanup: await witnessStates(trees.flatMap((owned) => owned.expectedWitnesses)),
              cleanupErrors: cleanup
                .filter((result) => result.status === "rejected")
                .map((result) => String(result.reason)),
            })}\n`,
          );
        }
        for (const result of cleanup) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      });
    });

    for (const reused of ["root", "child"] as const) {
      test(`a different ${reused} birth is not signaled while finishing saved custody`, async () => {
        await withTempHome(async (home) => {
          const sessionId = `retirement-reused-${reused}`;
          const tree = await startWitnessedTree();
          const [root, bridge, leaf] = tree.witnesses;
          assert(root && bridge && leaf);
          try {
            const paths = queuePaths(home, sessionId);
            await writeQueueOwnerLock({ ...paths, sessionId, ...root });
            const original = await readQueueOwnerRecord(sessionId);
            assert(original);
            // A saved older birth plus a currently live PID is the state after reuse;
            // no PID churn, host clock changes or unrelated process is needed.
            const older = {
              kind: "windows-creation" as const,
              value: "2000-01-01T00:00:00.0000000Z",
            };
            const savedRoot = reused === "root" ? { ...root, processIdentity: older } : root;
            if (reused === "child") {
              assert.equal((await runRetirer("partial", sessionId)).code, 23);
            }
            const savedLeaf = reused === "child" ? { ...leaf, processIdentity: older } : leaf;
            await fs.writeFile(
              paths.lockPath,
              JSON.stringify({
                ...original,
                processIdentity: savedRoot.processIdentity,
                retirement: {
                  ownerGeneration: original.ownerGeneration,
                  root: savedRoot,
                  descendants: [savedLeaf],
                },
              }),
            );
            const result = await runRetirer("retry", sessionId);
            assert.equal(result.code, undefined);
            assert.equal(result.taskkillCalls, 0);
            assert.deepEqual(
              await witnessStates(tree.witnesses),
              reused === "root" ? ["matching", "matching", "gone"] : ["gone", "gone", "matching"],
            );
            assert.equal(await readQueueOwnerRecord(sessionId), undefined);
          } finally {
            await stopWitnesses(tree.expectedWitnesses);
            await tree.closed;
          }
        });
      });
    }
  },
);
