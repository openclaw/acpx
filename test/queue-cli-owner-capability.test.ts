import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySetConfigOptionOnRunningOwner,
} from "../src/session/queue/ipc.js";
import { readQueueOwnerRecord } from "../src/session/queue/lease-store.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test(
  "new owner advertises a literal capability; malformed or absent values refuse CLI intent",
  { timeout: 12_000 },
  async () => {
    await withTempHome(async () => {
      const sessionId = "r033-new-owner";
      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert.ok(lease);
      const calls: Array<{ configId: string; value: string; cliModelInput?: true }> = [];
      const owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => false,
        closeSession: async () => false,
        setSessionMode: async () => {},
        setSessionModel: async () => undefined,
        setSessionConfigOption: async (configId, value, _timeoutMs, cliModelInput) => {
          calls.push({ configId, value, cliModelInput });
          return { configOptions: [] };
        },
      });
      const initial = await fs.readFile(lease.lockPath, "utf8");
      try {
        assert.equal((await readQueueOwnerRecord(sessionId))?.supportsCliConfigOptionIntent, true);
        const approved = await trySetConfigOptionOnRunningOwner(
          sessionId,
          "verbosity",
          " compact ",
          2000,
          false,
          undefined,
          true,
        );
        assert.deepEqual(approved?.value, { configOptions: [] });
        assert.deepEqual(calls, [
          { configId: "verbosity", value: " compact ", cliModelInput: true },
        ]);

        const baseline = JSON.parse(initial) as Record<string, unknown>;
        for (const variant of [undefined, false, "true", 1, null]) {
          const edited = { ...baseline, supportsCliConfigOptionIntent: variant };
          await fs.writeFile(lease.lockPath, JSON.stringify(edited) + "\n", "utf8");
          assert.equal(
            (await readQueueOwnerRecord(sessionId))?.supportsCliConfigOptionIntent,
            undefined,
          );
          await assert.rejects(
            trySetConfigOptionOnRunningOwner(
              sessionId,
              "verbosity",
              " compact ",
              2000,
              false,
              undefined,
              true,
            ),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.equal(
                (error as Error & { detailCode?: string }).detailCode,
                "QUEUE_CLI_CONFIG_OWNER_UNSUPPORTED",
              );
              return true;
            },
          );
          assert.equal(calls.length, 1, "a nonliteral capability cannot dispatch");
        }
      } finally {
        await fs.writeFile(lease.lockPath, initial, "utf8");
        await owner.close();
        await releaseQueueOwnerLease(lease);
      }
    });
  },
);

test(
  "an advertised owner cannot bypass strict request identity with an uncorrelated rejection",
  { timeout: 12_000 },
  async () => {
    await withTempHome(async (home) => {
      const sessionId = "r033-uncorrelated-reply";
      const paths = queuePaths(home, sessionId);
      const ownerGeneration = 123;
      let seen = 0;
      const server = createSingleRequestServer((socket, _request) => {
        seen += 1;
        socket.end(
          JSON.stringify({
            type: "error",
            requestId: "unknown",
            ownerGeneration,
            code: "RUNTIME",
            detailCode: "QUEUE_REQUEST_INVALID",
            origin: "queue",
            retryable: false,
            message: "Invalid queue request",
          }) + "\n",
        );
      });
      await listenServer(server, paths.socketPath);
      try {
        await writeQueueOwnerLock({
          ...paths,
          pid: process.pid,
          sessionId,
          ownerGeneration,
        });
        const payload = JSON.parse(await fs.readFile(paths.lockPath, "utf8")) as Record<
          string,
          unknown
        >;
        payload.supportsCliConfigOptionIntent = true;
        await fs.writeFile(paths.lockPath, JSON.stringify(payload) + "\n", "utf8");

        await assert.rejects(
          trySetConfigOptionOnRunningOwner(
            sessionId,
            "engine",
            " model-b ",
            2000,
            false,
            undefined,
            true,
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            const observed = error as Error & { detailCode?: string; retryable?: boolean };
            assert.equal(observed.detailCode, "QUEUE_PROTOCOL_MALFORMED_MESSAGE");
            assert.equal(observed.retryable, false);
            assert.match(observed.message, /outcome is unknown/);
            return true;
          },
        );
        assert.equal(seen, 1, "the fake server sent exactly one mismatched reply");
      } finally {
        await closeServer(server);
        await cleanupOwnerArtifacts(paths);
      }
    });
  },
);
