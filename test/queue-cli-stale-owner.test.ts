import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { trySetConfigOptionOnRunningOwner } from "../src/session/queue/ipc.js";
import { readQueueOwnerRecord } from "../src/session/queue/lease-store.js";
import {
  cleanupOwnerArtifacts,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  verifiedProcessIdentity,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test("CLI config control returns direct-route selection when no queue owner exists", async () => {
  await withTempHome(async () => {
    assert.equal(
      await trySetConfigOptionOnRunningOwner(
        "cli-config-without-owner",
        "verbosity",
        " exact ",
        2_000,
        false,
        undefined,
        true,
      ),
      undefined,
    );
  });
});

test("CLI config control retires a dead old owner before checking compatibility", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "cli-config-dead-old-owner";
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      ...paths,
      pid: 999_999,
      sessionId,
      ownerGeneration: 101,
    });
    try {
      assert.equal(
        (await readQueueOwnerRecord(sessionId))?.supportsCliConfigOptionIntent,
        undefined,
      );
      assert.equal(
        await trySetConfigOptionOnRunningOwner(
          sessionId,
          "verbosity",
          " exact ",
          2_000,
          false,
          undefined,
          true,
        ),
        undefined,
        "dead original owner must not turn into a false compatibility rejection",
      );
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      await assert.rejects(fs.access(paths.lockPath));
    } finally {
      await cleanupOwnerArtifacts(paths);
    }
  });
});

test(
  "CLI config control recovers a stale old owner by qualified identity, not by fallback retry",
  { timeout: 12_000 },
  async () => {
    await withTempHome(async (homeDir) => {
      const sessionId = "cli-config-stale-old-owner";
      const keeper = await startKeeperProcess();
      const paths = queuePaths(homeDir, sessionId);
      try {
        await writeQueueOwnerLock({
          ...paths,
          pid: keeper.pid,
          sessionId,
          ownerGeneration: 202,
          heartbeatAt: "2000-01-01T00:00:00.000Z",
          processIdentity: await verifiedProcessIdentity(keeper.pid),
        });
        assert.equal(
          (await readQueueOwnerRecord(sessionId))?.supportsCliConfigOptionIntent,
          undefined,
        );
        assert.equal(
          await trySetConfigOptionOnRunningOwner(
            sessionId,
            "verbosity",
            " exact ",
            2_000,
            false,
            undefined,
            true,
          ),
          undefined,
          "expired old owner must be reconciled before the CLI compatibility gate",
        );
        assert.equal(await readQueueOwnerRecord(sessionId), undefined);
        await assert.rejects(fs.access(paths.lockPath));
        assert.equal(keeper.exitCode === null && keeper.signalCode === null, false);
      } finally {
        await cleanupOwnerArtifacts(paths);
        stopProcess(keeper);
      }
    });
  },
);
