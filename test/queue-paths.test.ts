import assert from "node:assert/strict";
import test from "node:test";
import {
  queueBaseDir,
  queueKeyForSession,
  queueLockFilePath,
  queueSocketBaseDir,
  queueSocketPath,
} from "../src/cli/queue/paths.js";

test("queue path helpers derive stable lock and socket paths", () => {
  const homeDir = "/tmp/example-home";
  const key = queueKeyForSession("session-id");

  assert.equal(key.length, 24);
  assert.equal(queueBaseDir(homeDir), "/tmp/example-home/.acpx/queues");
  assert.equal(queueLockFilePath("session-id", homeDir), `${queueBaseDir(homeDir)}/${key}.lock`);

  if (process.platform === "win32") {
    assert.equal(queueSocketBaseDir(homeDir), undefined);
    assert.equal(queueSocketPath("session-id", homeDir), `\\\\.\\pipe\\acpx-${key}`);
    return;
  }

  assert.equal(queueSocketBaseDir(homeDir)?.startsWith("/tmp/acpx-"), true);
  assert.equal(queueSocketPath("session-id", homeDir).endsWith(`${key}.sock`), true);
});

test("queueSocketPath stays short on unix even for long home paths", () => {
  if (process.platform === "win32") {
    return;
  }

  const longHome =
    "/Users/example/Library/Containers/com.example.ReallyLongTemporaryHomePath/Somewhere/Deep";
  const socketPath = queueSocketPath("session-id-for-length-check", longHome);

  assert(socketPath.startsWith("/tmp/acpx-"));
  assert(socketPath.length < 104, socketPath);
});
