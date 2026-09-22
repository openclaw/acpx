import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";

const ACTOR = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
const { QueueOutputBudget, QueueSocketOutput } = await import(process.argv[1]);
let pathname;
let descriptor;
const open = fs.openSync;
fs.openSync = (...args) => {
  descriptor = open(...args);
  pathname = args[0];
  return descriptor;
};
class Socket extends EventEmitter {
  destroyed = false;
  writable = true;
  timeout = 0;
  write() { return false; }
  setTimeout(value) { this.timeout = value; }
  destroy(error) {
    process.send({ error: String(error) });
    process.exitCode = 1;
  }
}
const output = new QueueSocketOutput(new Socket(), new QueueOutputBudget());
output.send({ type: 'error', requestId: 'crash-fixture', message: 'x'.repeat(1024 * 1024) });
if (descriptor !== undefined && !process.exitCode) {
  const sample = Buffer.alloc(16);
  fs.readSync(descriptor, sample, 0, sample.length, 0);
  process.send({ pathname, bytes: fs.fstatSync(descriptor).size, sample: sample.toString(), pid: process.pid });
}
setTimeout(() => process.exit(2), 15_000);
`;

test("an abruptly stopped owner leaves no named output spool", { timeout: 10_000 }, async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      ACTOR,
      new URL("../src/session/queue/socket-output.js", import.meta.url).href,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const closed = once(child, "close");
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const [receipt] = (await once(child, "message", { signal: AbortSignal.timeout(5_000) })) as [
      { pathname?: string; bytes?: number; sample?: string; pid?: number; error?: string },
    ];
    assert.equal(receipt.error, undefined, stderr);
    assert.equal(receipt.pid, child.pid);
    assert.ok(receipt.pathname);
    assert.ok(receipt.bytes! > 0);
    assert.equal(receipt.sample, "x".repeat(16), "unlinked descriptor supports positional replay");
    await assert.rejects(fs.stat(receipt.pathname), { code: "ENOENT" });
    assert.equal(child.kill("SIGKILL"), true);
    await closed;
    await assert.rejects(fs.stat(receipt.pathname), { code: "ENOENT" });
    process.stdout.write(
      `QUEUE_SPOOL_CRASH ${JSON.stringify({ pid: child.pid, unlinked: true, childClosed: true })}\n`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
});
