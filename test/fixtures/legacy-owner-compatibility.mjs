// Run after compiling both revisions: node test/fixtures/legacy-owner-compatibility.mjs
// <current dist-test directory> <released dist/cli.js>
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [currentTests, legacyCli] = process.argv.slice(2);
assert(currentTests && legacyCli, "Expected current dist-test and released CLI paths");
const load = async (relative) => await import(pathToFileURL(path.resolve(currentTests, relative)));
const { makeSessionRecord, withTempHome, writeSessionRecordFile } = await load(
  "test/runtime-test-helpers.js",
);
const { normalizeAgentCommandInput } = await load("src/acp/client-process.js");
const { sendSession } = await load("src/session/execution/queue-owner-runtime.js");
const { closeSession } = await load("src/session/execution/session-control.js");
const { readQueueOwnerRecord, isProcessAlive } = await load("src/session/queue/lease-store.js");
const { queueSocketBaseDir } = await load("src/session/queue/paths.js");
const { probeProcessIdentity } = await load("src/process-identity.js");

const agentSource = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const [pidFile, supportsClose] = process.argv.slice(2);
const leaf = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000)'], { detached: true, stdio: 'ignore' });
await new Promise((resolve, reject) => { leaf.once('spawn', resolve); leaf.once('error', reject); });
fs.writeFileSync(pidFile, JSON.stringify([process.pid, leaf.pid]));
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (leaf.exitCode != null || leaf.signalCode != null) process.exit(0);
  leaf.once('close', () => process.exit(0));
  leaf.kill('SIGKILL');
};
setTimeout(stop, 30000);
readline.createInterface({input:process.stdin}).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') send(id, {protocolVersion:1,agentCapabilities:{loadSession:true,...(supportsClose==='true'?{sessionCapabilities:{close:{}}}:{})}});
  else if (method === 'session/load' || method === 'session/close') send(id, {});
  else if (method === 'session/prompt') send(id, {stopReason:'end_turn'});
  else if (id !== undefined) send(id, {});
}).on('close', stop);
process.once('SIGTERM', stop);
`;

for (const supportsClose of [false, true]) {
  await withTempHome("acpx-released-owner-", async (home) => {
    const agent = path.join(home, "agent.mjs");
    const pidFile = path.join(home, "children.json");
    await fs.writeFile(agent, agentSource);
    const sessionId = `released-owner-${supportsClose}`;
    const record = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: "released-backend",
      cwd: home,
      ...normalizeAgentCommandInput([process.execPath, agent, pidFile, String(supportsClose)]),
    });
    await writeSessionRecordFile(home, record);
    const formatter = {
      setContext() {},
      onAcpMessage() {},
      onError() {},
      onPermissionEscalation() {},
      flush() {},
    };
    const prompt = () =>
      sendSession({
        sessionId,
        prompt: [{ type: "text", text: "compatibility" }],
        permissionMode: "deny-all",
        ttlMs: 20_000,
        timeoutMs: 8_000,
        outputFormatter: formatter,
        queueOwnerArgs: [path.resolve(legacyCli), "__queue-owner"],
      });
    let owner;
    let children = [];
    const ownedIdentities = new Map();
    const originalKill = process.kill.bind(process);
    const originalExecFile = childProcess.execFile;
    const forcedSignals = [];
    let failure;
    async function cleanupFixture() {
      try {
        process.kill = originalKill;
        childProcess.execFile = originalExecFile;
        syncBuiltinESMExports();
        owner ??= await readQueueOwnerRecord(sessionId);
        if (children.length === 0) {
          const saved = await fs.readFile(pidFile, "utf8").catch((error) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
            return undefined;
          });
          if (saved) {
            children = JSON.parse(saved);
          }
        }
        for (const pid of [...children.toReversed(), owner?.pid].filter((pid) =>
          Number.isSafeInteger(pid),
        )) {
          // Never establish ownership during fallback: a saved PID may already
          // belong to another incarnation after cooperative shutdown.
          const expected = ownedIdentities.get(pid);
          if (!expected || !isProcessAlive(pid)) {
            continue;
          }
          const observed = await probeProcessIdentity(pid);
          if (
            observed.state === "alive" &&
            observed.identity.kind === expected.kind &&
            observed.identity.value === expected.value
          ) {
            try {
              originalKill(pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") {
                throw error;
              }
            }
          }
        }
        const ownedPids = [...children, owner?.pid].filter((pid) => Number.isSafeInteger(pid));
        for (let attempt = 0; attempt < 100 && ownedPids.some(isProcessAlive); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          ownedPids.some(isProcessAlive),
          false,
          "owned compatibility processes did not exit",
        );
        const socketDir = queueSocketBaseDir(home);
        if (socketDir) {
          await fs.rm(socketDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        if (failure !== undefined) {
          throw new AggregateError(
            [failure, cleanupError],
            "Released-owner proof and cleanup both failed",
            { cause: failure },
          );
        }
        throw cleanupError;
      }
    }
    try {
      await prompt();
      owner = await readQueueOwnerRecord(sessionId);
      assert(
        owner && !owner.processIdentity,
        "the actual released owner must have no birth identity",
      );
      children = JSON.parse(await fs.readFile(pidFile, "utf8"));
      assert.equal(children.length, 2);
      for (const pid of [owner.pid, ...children]) {
        const observed = await probeProcessIdentity(pid);
        assert.equal(observed.state, "alive", "capture fixture birth at owned readiness");
        ownedIdentities.set(pid, observed.identity);
      }
      await prompt();
      const reused = await readQueueOwnerRecord(sessionId);
      assert(reused && !reused.processIdentity);
      for (const field of ["pid", "ownerGeneration", "createdAt", "socketPath"]) {
        assert.equal(
          reused[field],
          owner[field],
          `warm reuse must retain the released owner's ${field}`,
        );
      }
      process.kill = (pid, signal) => {
        if (pid === owner.pid && signal !== 0) {
          forcedSignals.push(signal);
        }
        return originalKill(pid, signal);
      };
      childProcess.execFile = (command, ...args) => {
        if (path.win32.basename(command).toLowerCase() === "taskkill.exe") {
          forcedSignals.push("taskkill");
        }
        return originalExecFile(command, ...args);
      };
      syncBuiltinESMExports();
      const started = performance.now();
      const closed = await closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.deepEqual(forcedSignals, [], "legacy owner close must remain cooperative");
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.deepEqual([owner.pid, ...children].map(isProcessAlive), [false, false, false]);
      console.log(
        JSON.stringify({
          supportsClose,
          ownerReused: true,
          noBirthIdentity: true,
          forcedSignals,
          allExited: true,
          closeMs: Math.round(performance.now() - started),
        }),
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await cleanupFixture();
    }
  });
}
