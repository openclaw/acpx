import assert from "node:assert/strict";
import test from "node:test";
import { queueSocketPath } from "../src/queue-paths.js";

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
