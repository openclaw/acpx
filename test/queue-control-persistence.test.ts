import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  setSessionConfigOption,
  setSessionMode,
  setSessionModel,
} from "../src/session/execution/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { trySetModeOnRunningOwner } from "../src/session/queue/ipc.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const EFFORT = {
  id: "effort",
  name: "Effort",
  type: "select",
  currentValue: "high",
  options: [
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};

for (const capable of [false, true]) {
  for (const control of ["mode", "model", "effort"] as const) {
    test(`${control} control persistence belongs to the ${capable ? "capable owner" : "legacy caller"}`, async () => {
      await withTempHome("acpx-control-persistence-", async (home) => {
        const record = makeSessionRecord({
          acpxRecordId: "control-persistence",
          agentCommand: "unused-test-agent",
          acpSessionId: "provider",
          cwd: home,
        });
        await writeSessionRecordFile(home, record);
        const file = sessionFilePath(home, record.acpxRecordId);
        const paths = queuePaths(home, record.acpxRecordId);
        const keeper = await startKeeperProcess();
        await writeQueueOwnerLock({ ...paths, sessionId: record.acpxRecordId, pid: keeper.pid });
        if (capable) {
          const lease = JSON.parse(await fs.readFile(paths.lockPath, "utf8")) as Record<
            string,
            unknown
          >;
          await fs.writeFile(
            paths.lockPath,
            JSON.stringify({ ...lease, persistsControlState: true }),
          );
        }
        let persisted: Awaited<ReturnType<typeof fs.stat>> | undefined;
        const server = createSingleRequestServer((socket, request) => {
          void (async () => {
            if (capable) {
              record.acpx =
                control === "mode"
                  ? { desired_mode_id: "plan" }
                  : control === "model"
                    ? { session_options: { model: "smart-model" } }
                    : { desired_config_options: { effort: "high" } };
              await writeSessionRecordFile(home, record);
              persisted = await fs.stat(file);
            }
            socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
            const response =
              control === "mode"
                ? { type: "set_mode_result", modeId: "plan" }
                : control === "model"
                  ? { type: "set_model_result", modelId: "smart-model" }
                  : { type: "set_config_option_result", response: { configOptions: [EFFORT] } };
            socket.end(`${JSON.stringify({ ...response, requestId: request.requestId })}\n`);
          })().catch((error: unknown) =>
            socket.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        });
        await listenServer(server, paths.socketPath);
        try {
          const args = { sessionId: record.acpxRecordId, timeoutMs: 2000 };
          if (control === "mode") {
            await setSessionMode({ ...args, modeId: "plan" });
          } else if (control === "model") {
            await setSessionModel({ ...args, modelId: "smart-model" });
          } else {
            await setSessionConfigOption({ ...args, configId: "effort", value: "high" });
          }
          const saved = await resolveSessionRecord(record.acpxRecordId);
          if (control === "mode") {
            assert.equal(saved.acpx?.desired_mode_id, "plan");
          } else if (control === "model") {
            assert.equal(saved.acpx?.session_options?.model, "smart-model");
          } else {
            assert.equal(saved.acpx?.desired_config_options?.effort, "high");
          }
          if (capable) {
            assert.ok(persisted);
            const after = await fs.stat(file);
            assert.equal(
              after.ino,
              persisted.ino,
              "caller must not replace the owner's canonical record",
            );
            assert.equal(
              after.mtimeMs,
              persisted.mtimeMs,
              "caller must not rewrite the owner's canonical record",
            );
          }
        } finally {
          await closeServer(server);
          await cleanupOwnerArtifacts(paths);
          stopProcess(keeper);
        }
      });
    });
  }
}

for (const initialCapability of [false, true]) {
  test(`control captures capability ${initialCapability} from its contacted owner generation`, async () => {
    await withTempHome("acpx-control-generation-", async (home) => {
      const sessionId = "generation-control";
      const paths = queuePaths(home, sessionId);
      const keeper = await startKeeperProcess();
      await writeQueueOwnerLock({ ...paths, sessionId, pid: keeper.pid, ownerGeneration: 100 });
      const lease = JSON.parse(await fs.readFile(paths.lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      await fs.writeFile(
        paths.lockPath,
        JSON.stringify({ ...lease, persistsControlState: initialCapability }),
      );
      const server = createSingleRequestServer((socket, request) => {
        void (async () => {
          await fs.writeFile(
            paths.lockPath,
            JSON.stringify({
              ...lease,
              ownerGeneration: 101,
              persistsControlState: !initialCapability,
            }),
          );
          socket.write(
            `${JSON.stringify({ type: "accepted", requestId: request.requestId, ownerGeneration: 100 })}\n`,
          );
          socket.end(
            `${JSON.stringify({ type: "set_mode_result", requestId: request.requestId, modeId: "plan", ownerGeneration: 100 })}\n`,
          );
        })().catch((error: unknown) =>
          socket.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      });
      await listenServer(server, paths.socketPath);
      try {
        assert.deepEqual(await trySetModeOnRunningOwner(sessionId, "plan", 2000, false), {
          value: true,
          persistsControlState: initialCapability,
        });
      } finally {
        await closeServer(server);
        await cleanupOwnerArtifacts(paths);
        stopProcess(keeper);
      }
    });
  });
}
