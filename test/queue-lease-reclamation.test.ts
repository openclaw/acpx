import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  readQueueOwnerRecord,
  releaseQueueOwnerLease,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/session/queue/lease-store.js";
import {
  queueLockFilePath,
  queueSocketBaseDir,
  queueSocketPath,
} from "../src/session/queue/paths.js";
import { withTempHome } from "./queue-test-helpers.js";

function connectEndpoint(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      received += data;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(received));
  });
}

for (const pausedMutation of ["socket", "lease"] as const) {
  test(
    `separate stale cleaners preserve replacement ownership at ${pausedMutation} unlink`,
    { skip: pausedMutation === "socket" && process.platform === "win32", timeout: 20_000 },
    async () => {
      await withTempHome(async (home) => {
        const sessionId = `cleanup-${randomUUID()}`;
        const lockPath = queueLockFilePath(sessionId),
          socketPath = queueSocketPath(sessionId);
        const socketDir = queueSocketBaseDir();
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        if (socketDir) {
          await fs.mkdir(socketDir, { recursive: true });
          await fs.writeFile(socketPath, "abandoned endpoint");
        }
        const old = {
          pid: 2147483647,
          sessionId,
          socketPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          heartbeatAt: "2000-01-01T00:00:00.000Z",
          ownerGeneration: 1,
          queueDepth: 0,
        };
        await fs.writeFile(lockPath, JSON.stringify(old));
        const selected = pausedMutation === "socket" ? socketPath : lockPath;
        const source = `
          import fs from 'node:fs/promises';import net from 'node:net';import {setTimeout as delay} from 'node:timers/promises';
          import {terminateQueueOwnerForSession,tryAcquireQueueOwnerLease,releaseQueueOwnerLease} from ${JSON.stringify(new URL("../src/session/queue/lease-store.js", import.meta.url).href)};
          const old=${JSON.stringify(old)},selected=${JSON.stringify(path.basename(selected))};
          const messages=new Map();process.on('message',name=>messages.get(name)?.());
          const wait=name=>new Promise(resolve=>messages.set(name,resolve));
          const mode=process.argv[1],resume=wait('resume'),stop=wait('stop');
          if(mode==='cleaner'){
            const unlink=fs.unlink;let paused=false;
            fs.unlink=async file=>{if(!paused&&String(file).endsWith(selected)){paused=true;process.send('unlink-ready');await resume;}return await unlink(file);};
            await terminateQueueOwnerForSession(old.sessionId,old,true);
            process.send('cleaned');process.disconnect();
          }else{
            const warmup=await tryAcquireQueueOwnerLease(old.sessionId+'-warmup');
            if(!warmup)throw new Error('warmup lease unavailable');
            await releaseQueueOwnerLease(warmup);
            process.send('attempting');
            await terminateQueueOwnerForSession(old.sessionId,old,true);
            let lease;
            while(!lease){lease=await tryAcquireQueueOwnerLease(old.sessionId);if(!lease)await delay(5);}
            const server=net.createServer(socket=>socket.end('owned'));
            await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(lease.socketPath,resolve);});
            process.send('listening');
            await stop;
            await new Promise(resolve=>server.close(resolve));
            await releaseQueueOwnerLease(lease);
            process.send('released');process.disconnect();
          }
        `;
        const start = (mode: string) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", source, mode],
            { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"] },
          );
          const messages: string[] = [];
          let stderr = "";
          child.on("message", (message) => {
            assert.equal(typeof message, "string");
            if (typeof message === "string") {
              messages.push(message);
            }
          });
          child.stderr!.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          const exited = once(child, "close");
          const waitFor = async (message: string) => {
            const end = Date.now() + 10000;
            while (!messages.includes(message)) {
              assert.equal(child.exitCode, null, stderr);
              assert.ok(Date.now() < end, `missing ${message}: ${stderr}`);
              await delay(5);
            }
          };
          return { child, messages, exited, waitFor };
        };
        const cleaner = start("cleaner");
        let replacement: ReturnType<typeof start> | undefined;
        try {
          await cleaner.waitFor("unlink-ready");
          replacement = start("replacement");
          await replacement.waitFor("attempting");
          await delay(300);
          assert.equal(
            replacement.messages.includes("listening"),
            false,
            "replacement published while stale cleanup held destructive authority",
          );
          cleaner.child.send("resume");
          await cleaner.waitFor("cleaned");
          await replacement.waitFor("listening");
          const admitted = await readQueueOwnerRecord(sessionId);
          assert.ok(admitted);
          assert.equal(admitted.pid, replacement.child.pid);
          await terminateQueueOwnerForSession(sessionId, old, true);
          assert.equal(
            (await readQueueOwnerRecord(sessionId))?.ownerGeneration,
            admitted.ownerGeneration,
          );
          assert.equal(await connectEndpoint(socketPath), "owned");
          assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
          replacement.child.send("stop");
          await replacement.waitFor("released");
          assert.deepEqual(await cleaner.exited, [0, null]);
          assert.deepEqual(await replacement.exited, [0, null]);
          const successor = await tryAcquireQueueOwnerLease(sessionId);
          assert.ok(successor);
          await releaseQueueOwnerLease(successor);
        } finally {
          for (const actor of [cleaner, replacement]) {
            if (actor && actor.child.exitCode === null && actor.child.signalCode === null) {
              actor.child.kill("SIGKILL");
              await actor.exited;
            }
          }
          await fs.rm(lockPath, { force: true });
          if (socketDir) {
            await fs.rm(socketPath, { force: true });
            await fs.rmdir(socketDir).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
                throw error;
              }
            });
          }
        }
      });
    },
  );
}
