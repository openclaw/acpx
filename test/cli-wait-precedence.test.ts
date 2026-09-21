import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withTimeout } from "../src/async-control.js";
import { watchSession } from "../src/session/journal.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import {
  readQueueOwnerRecord,
  terminateProcess,
  terminateQueueOwnerForSession,
} from "../src/session/queue/lease-store.js";
import { extractAgentMessageChunkText } from "./jsonrpc-test-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// This bounds failure/cleanup only. Readiness and ordering use explicit barriers.
const WATCHDOG_MS = 20_000;

function startCli(args: string[], home: string, cwd: string) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
  void result.catch(() => {});
  return { child, result, snapshot: () => ({ stdout, stderr, closed }) };
}

type Cli = ReturnType<typeof startCli>;

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + WATCHDOG_MS;
  while (!(await check())) {
    assert(Date.now() < deadline, `Watchdog expired: ${label}`);
    await delay(20);
  }
}

async function held(cli: Cli): Promise<void> {
  await until(async () => {
    const snapshot = cli.snapshot();
    assert.equal(snapshot.closed, false, `CLI exited before barrier: ${snapshot.stderr}`);
    return snapshot.stdout
      .split("\n")
      .slice(0, -1)
      .some((line) => extractAgentMessageChunkText(JSON.parse(line)) === "flow-held");
  }, "mock peer's live held-turn update");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function withQueuedSession(
  run: (fixture: {
    start: (args: string[]) => Cli;
    sessionId: string;
    firstRelease: string;
    secondRelease: string;
    rememberOwner: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-cli-wait-", async (home) => {
    const cwd = path.join(home, "workspace");
    const pidFile = path.join(home, "peer.pid");
    const firstRelease = path.join(home, "release-first");
    const secondRelease = path.join(home, "release-second");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(home, ".acpx"));
    await fs.writeFile(
      path.join(home, ".acpx", "config.json"),
      JSON.stringify({
        agents: {
          codex: {
            argv: [
              process.execPath,
              MOCK_AGENT_PATH,
              "--supports-load-session",
              "--pid-file",
              pidFile,
            ],
          },
        },
      }),
    );
    const children: Cli[] = [];
    const pids = new Set<number>();
    const start = (args: string[]) => {
      const cli = startCli(
        ["--cwd", cwd, "--approve-all", "--format", "json", "--ttl", "60", ...args],
        home,
        cwd,
      );
      children.push(cli);
      return cli;
    };
    let sessionId: string | undefined;
    const rememberOwner = async () => {
      assert(sessionId);
      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner, "held turn must have a queue owner");
      pids.add(owner.pid);
      const peerPid = Number(await fs.readFile(pidFile, "utf8"));
      assert(Number.isSafeInteger(peerPid) && peerPid > 0);
      pids.add(peerPid);
    };
    try {
      const created = await withTimeout(start(["codex", "sessions", "new"]).result, WATCHDOG_MS);
      assert.equal(created.code, 0, created.stderr);
      const payload = JSON.parse(created.stdout) as { acpxRecordId: string };
      sessionId = payload.acpxRecordId;
      assert.equal(typeof sessionId, "string");
      await run({ start, sessionId, firstRelease, secondRelease, rememberOwner });
      const closed = await withTimeout(start(["codex", "sessions", "close"]).result, WATCHDOG_MS);
      assert.equal(closed.code, 0, closed.stderr);
      await until(async () => [...pids].every((pid) => !alive(pid)), "owned processes to exit");
    } finally {
      // This file is written only by this fixture's mock peers, including startup failures.
      const lastPeer = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
      if (Number.isSafeInteger(lastPeer) && lastPeer > 0) {
        pids.add(lastPeer);
      }
      await Promise.all([
        fs.writeFile(firstRelease, "release"),
        fs.writeFile(secondRelease, "release"),
      ]);
      for (const cli of children) {
        if (!cli.snapshot().closed) {
          cli.child.kill("SIGKILL");
        }
      }
      await withTimeout(Promise.allSettled(children.map((cli) => cli.result)), WATCHDOG_MS);
      if (sessionId) {
        await terminateQueueOwnerForSession(sessionId);
      }
      for (const pid of pids) {
        if (alive(pid)) {
          await terminateProcess(pid);
        }
      }
      await until(
        async () => [...pids].every((pid) => !alive(pid)),
        "exact cleanup targets to exit",
      );
    }
  });
}

for (const placement of ["parent", "child"] as const) {
  test(`CLI ${placement} --no-wait exits with acknowledgement before the active turn is released`, async () => {
    await withQueuedSession(async (f) => {
      const first = f.start(["codex", "prompt", `stream-wait-file ${f.firstRelease}`]);
      await held(first);
      await f.rememberOwner();
      const marker = `accepted-${placement}-no-wait`;
      const second = f.start([
        "codex",
        ...(placement === "parent" ? ["--no-wait", "prompt"] : ["prompt", "--no-wait"]),
        `echo ${marker}`,
      ]);
      const queued = await withTimeout(second.result, WATCHDOG_MS);
      assert.equal(queued.code, 0, queued.stderr);
      const ack = JSON.parse(queued.stdout) as {
        action: string;
        acpxRecordId: string;
        requestId: string;
      };
      assert.equal(ack.action, "prompt_queued");
      assert.equal(ack.acpxRecordId, f.sessionId);
      assert.equal(typeof ack.requestId, "string");
      assert.notEqual(ack.requestId, "");
      assert.equal(first.snapshot().closed, false);
      await assert.rejects(fs.access(f.firstRelease), { code: "ENOENT" });
      await fs.writeFile(f.firstRelease, "release");
      const firstResult = await withTimeout(first.result, WATCHDOG_MS);
      assert.equal(firstResult.code, 0, firstResult.stderr);

      const record = await resolveSessionRecord(f.sessionId);
      let sawReply = false;
      let completed = false;
      for await (const event of watchSession({
        record,
        signal: AbortSignal.timeout(WATCHDOG_MS),
      })) {
        if (event.requestId !== ack.requestId) {
          continue;
        }
        if (event.type === "message") {
          sawReply ||= extractAgentMessageChunkText(event.message) === marker;
        }
        if (event.type === "turn_result") {
          assert.equal(event.result.status, "completed");
          completed = true;
          break;
        }
      }
      assert.equal(completed, true, "the acknowledged work must eventually finish");
      assert.equal(sawReply, true, "the accepted turn must produce the expected assistant reply");
    });
  });
}

test("CLI prompt waits by default through queue admission and its own held turn", async () => {
  await withQueuedSession(async (f) => {
    const first = f.start(["codex", "prompt", `stream-wait-file ${f.firstRelease}`]);
    await held(first);
    await f.rememberOwner();
    const second = f.start(["codex", "prompt", `stream-wait-file ${f.secondRelease}`]);
    await until(
      async () => (await readQueueOwnerRecord(f.sessionId))?.queueDepth === 1,
      "the second turn to be queued behind the held first turn",
    );
    await fs.writeFile(f.firstRelease, "release");
    const firstResult = await withTimeout(first.result, WATCHDOG_MS);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    await held(second);
    assert.doesNotMatch(second.snapshot().stdout, /prompt_queued/);
    await assert.rejects(fs.access(f.secondRelease), { code: "ENOENT" });
    await fs.writeFile(f.secondRelease, "release");
    const result = await withTimeout(second.result, WATCHDOG_MS);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /stream-wait-file done: flow-held/);
    assert.doesNotMatch(result.stdout, /prompt_queued/);
  });
});
