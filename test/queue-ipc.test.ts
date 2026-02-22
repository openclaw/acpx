import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

type SessionModule = typeof import("../src/session.js");

const SESSION_MODULE_URL = new URL("../src/session.js", import.meta.url);

test("cancelSessionPrompt sends cancel request to active queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const sessionId = "cancel-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        const request = JSON.parse(line) as { requestId: string; type: string };
        assert.equal(request.type, "cancel_prompt");
        socket.write(
          `${JSON.stringify({
            type: "accepted",
            requestId: request.requestId,
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "cancel_result",
            requestId: request.requestId,
            cancelled: true,
          })}\n`,
        );
        socket.end();
      });
    });

    await listenServer(server, socketPath);

    try {
      const result = await session.cancelSessionPrompt({ sessionId });
      assert.equal(result.cancelled, true);
      assert.equal(result.sessionId, sessionId);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`
  )) as SessionModule;
}
