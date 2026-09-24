import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ShellActionResult } from "../src/flows/types.js";
import { observeProcessIncarnation, parseProcessBirthIdentity } from "../src/process-identity.js";
import type { HostReport, ReadyRecord, RetirementMode } from "./fixtures/flow-shell-retirement.js";

const fixture = fileURLToPath(new URL("./fixtures/flow-shell-retirement.js", import.meta.url));
const exec = promisify(execFile);
type NativeState = "matching" | "gone" | "zombie" | "unknown";
type ExitReceipt = { code: number | null; signal: NodeJS.Signals | null; at: number };
class FixtureTimeout extends Error {}

async function until<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new FixtureTimeout(`Timed out waiting for ${label}`);
    }
    await delay(20);
  }
}

async function readJson<T>(root: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function marker(root: string, name: string, nonce: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(root, name), "utf8")) === nonce;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function nativeState(owned: ReadyRecord): Promise<NativeState> {
  const incarnation = await observeProcessIncarnation(owned.pid, owned.birth);
  if (incarnation === "gone" || process.platform === "win32") {
    return incarnation;
  }
  // Reparented zombies are terminated, even when kill(pid, 0) still succeeds.
  try {
    const { stdout } = await exec("ps", ["-p", String(owned.pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (stdout.trim().startsWith("Z")) {
      return "zombie";
    }
    return stdout.trim().length > 0 ? incarnation : "unknown";
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return "gone";
    }
    throw error;
  }
}

function stopped(value: NativeState): boolean {
  return value === "gone" || value === "zombie";
}

function assertEarly(result: ShellActionResult | undefined): void {
  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "early stdout\n");
  assert.equal(result.stderr, "early stderr\n");
  assert.equal(result.combinedOutput, "early stdout\nearly stderr\n");
}

async function retirementCase(t: TestContext, mode: RetirementMode): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-retirement-"));
  const nonce = randomUUID();
  const owned = new Map<string, ReadyRecord>();
  const events: Array<{ name: string; at: number; detail?: unknown }> = [];
  const note = (name: string, detail?: unknown) => events.push({ name, at: Date.now(), detail });
  const host = spawn(process.execPath, [fixture, root, nonce, "host", mode], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let exited: ExitReceipt | undefined;
  let closed: ExitReceipt | undefined;
  let stdoutEof: number | undefined;
  let stderrEof: number | undefined;
  let spawnError: Error | undefined;
  host.stdout.setEncoding("utf8");
  host.stderr.setEncoding("utf8");
  host.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  host.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  host.stdout.once("end", () => {
    stdoutEof = Date.now();
    note("host.stdout-eof");
  });
  host.stderr.once("end", () => {
    stderrEof = Date.now();
    note("host.stderr-eof");
  });
  host.once("error", (error) => {
    spawnError = error;
    note("host.spawn-error", error.message);
  });
  host.once("exit", (code, signal) => {
    exited = { code, signal, at: Date.now() };
    note("host.exit", exited);
  });
  host.once("close", (code, signal) => {
    closed = { code, signal, at: Date.now() };
    note("host.close", closed);
  });

  const readReady = async (role: string): Promise<ReadyRecord | undefined> => {
    const record = await readJson<ReadyRecord>(root, `${role}.ready.json`);
    if (!record) {
      return undefined;
    }
    assert.equal(record.nonce, nonce);
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
    const birth = parseProcessBirthIdentity(record.birth);
    assert.ok(birth, `${role} must publish a native birth identity`);
    const verified = { ...record, birth };
    owned.set(role, verified);
    return verified;
  };
  const joined = () =>
    exited !== undefined &&
    closed !== undefined &&
    stdoutEof !== undefined &&
    stderrEof !== undefined;
  let failure: unknown;
  let failed = false;
  try {
    // Startup receives its own generous bound; it is not the host-exit assertion.
    const descendant = await until(
      "separate host/wrapper/descendant readiness",
      30_000,
      async () => {
        if (spawnError) {
          throw spawnError;
        }
        assert.equal(exited, undefined, `host exited before admission: ${stderr}`);
        const records = await Promise.all([
          readReady("host"),
          readReady("wrapper"),
          readReady("descendant"),
        ]);
        return records.every((record) => record !== undefined) ? records[2] : undefined;
      },
    );
    for (const [role, identity] of owned) {
      assert.equal(
        await nativeState(identity),
        "matching",
        `${role} must be natively alive before wrapper release`,
      );
    }
    note("ready", [...owned]);
    await fs.writeFile(path.join(root, "release-wrapper"), nonce);
    note("release-wrapper");

    if (mode === "late-cancel") {
      const waiting = await until("completed shell and held next node", 10_000, async () => {
        assert.equal(exited, undefined, `host exited before the next-node barrier: ${stderr}`);
        return await readJson<{ nonce: string; result: ShellActionResult }>(root, "waiting.json");
      });
      assert.equal(waiting.nonce, nonce);
      assertEarly(waiting.result);
      assert.ok(
        stopped(await nativeState(owned.get("wrapper")!)),
        "wrapper must already have exited",
      );
      await fs.writeFile(path.join(root, "write-late"), nonce);
      const late = await until("both inherited pipes to drain", 10_000, async () => {
        assert.equal(exited, undefined, `host exited while subsequent work was held: ${stderr}`);
        return await readJson<{
          nonce: string;
          ok: boolean;
          bytesPerStream?: number;
          message?: string;
        }>(root, "late-written.json");
      });
      assert.equal(late.nonce, nonce);
      assert.equal(late.ok, true, late.message ?? "both inherited pipes must drain");
      assert.equal(late.bytesPerStream, 2 * 1024 * 1024);
      for (const stream of ["stdout", "stderr"]) {
        assert.equal(await readJson(root, `descendant.${stream}.error.json`), undefined);
      }
      note("late-output-drained", late);
      assert.equal(host.kill("SIGINT"), true, "signal the exact host handle, not the shell group");
      note("host-sigint");
    }

    const report = await until("host result", 10_000, async () => {
      if (spawnError) {
        throw spawnError;
      }
      const value = await readJson<HostReport>(root, "host-result.json");
      if (!value) {
        assert.equal(exited, undefined, `host exited without a result: ${stderr}`);
      }
      return value;
    });
    assert.equal(report.nonce, nonce);
    assert.equal(report.ending, mode === "late-cancel" ? "InterruptedError" : "ok");
    assertEarly(report.result);
    note("host-result", report);
    // This bound starts only after result publication. C is still held: no rescue yet.
    await until("natural host exit, close, and both pipe EOFs", 8_000, async () =>
      joined() ? true : undefined,
    );
    const exitReceipt = (): ExitReceipt | undefined => exited;
    assert.equal(exitReceipt()?.code, 0, stderr);
    assert.equal(exitReceipt()?.signal, null);
    assert.deepEqual(JSON.parse(stdout), report);
    if (mode === "late-cancel") {
      assert.equal(await marker(root, "descendant.sigint", nonce), true);
      assert.ok(
        stopped(await nativeState(descendant)),
        "product cancellation must retire C before rescue",
      );
    } else {
      assert.equal(
        await nativeState(descendant),
        "matching",
        "C must remain alive after H naturally exits",
      );
      await fs.writeFile(path.join(root, "ping"), nonce);
      await until("held descendant response after host exit", 5_000, async () =>
        (await marker(root, "pong", nonce)) ? true : undefined,
      );
      note("descendant-responsive-after-host-exit");
    }
    for (const role of ["wrapper", "descendant"]) {
      assert.equal(
        await marker(root, `${role}.emergency`, nonce),
        false,
        `${role} emergency exit cannot prove normal completion`,
      );
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  const cleanup = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  // Save the native child observations before the first cooperative or forced rescue.
  const preRescue: Record<string, unknown> = {};
  for (const role of ["wrapper", "descendant"]) {
    await cleanup(async () => {
      const identity = owned.get(role) ?? (await readReady(role));
      preRescue[role] = identity
        ? { identity, state: await nativeState(identity) }
        : { ready: false };
    });
  }
  note("pre-rescue", { exited, closed, stdoutEof, stderrEof, processes: preRescue });
  await cleanup(async () => {
    await fs.writeFile(
      path.join(root, "pre-rescue.json"),
      JSON.stringify({ mode, nonce, events }, null, 2),
    );
  });
  await cleanup(async () => {
    await fs.writeFile(path.join(root, "stop"), nonce);
    note("cooperative-stop");
  });
  for (const role of ["descendant", "wrapper"]) {
    await cleanup(async () => {
      const identity = owned.get(role) ?? (await readReady(role));
      if (!identity) {
        return;
      }
      try {
        await until(`${role} cooperative retirement`, 3_000, async () =>
          stopped(await nativeState(identity)) ? true : undefined,
        );
        note(`${role}.retired-cooperatively`);
        return;
      } catch (error) {
        if (!(error instanceof FixtureTimeout)) {
          throw error;
        }
        // Re-observe immediately before rescue; unknown/reused identities are never signalled.
        const observed = await nativeState(identity);
        if (stopped(observed)) {
          return;
        }
        assert.equal(
          observed,
          "matching",
          `cannot safely rescue ${role}: native identity is ${observed}`,
        );
        assert.equal(await observeProcessIncarnation(identity.pid, identity.birth), "matching");
        try {
          process.kill(identity.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
        note(`${role}.identity-checked-sigkill`);
      }
      await until(`${role} forced retirement`, 5_000, async () =>
        stopped(await nativeState(identity)) ? true : undefined,
      );
    });
  }
  await cleanup(async () => {
    if (!joined()) {
      try {
        await until("host join after descendant stop", 2_000, async () =>
          joined() ? true : undefined,
        );
      } catch {
        // H is still owned through its actual unreaped ChildProcess, never a saved raw PID.
        if (!exited && !spawnError) {
          host.kill("SIGINT");
          note("host.rescue-sigint");
        }
        try {
          await until("host interrupt join", 3_000, async () =>
            joined() || (spawnError && closed) ? true : undefined,
          );
        } catch {
          if (!exited && !spawnError) {
            host.kill("SIGKILL");
            note("host.rescue-sigkill");
          }
          await until("host kill join", 5_000, async () =>
            joined() || (spawnError && closed) ? true : undefined,
          );
        }
      }
    }
    assert.ok(
      joined() || (spawnError && closed),
      "cleanup must join real host events; never synthesize EOF",
    );
  });
  await cleanup(async () => {
    for (const role of ["wrapper", "descendant"]) {
      assert.equal(
        await marker(root, `${role}.emergency`, nonce),
        false,
        `${role} emergency exit fired during this case`,
      );
    }
  });
  note("cleanup-finished", {
    failed,
    cleanupErrors: cleanupErrors.map(String),
    exited,
    closed,
    stdoutEof,
    stderrEof,
  });
  t.diagnostic(
    JSON.stringify({ mode, platform: process.platform, node: process.version, root, events }),
  );
  // Preserve the directory if resource cleanup itself failed, for exact-owner recovery.
  if (cleanupErrors.length === 0) {
    await cleanup(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      `Shell retirement cleanup failed: ${root}`,
    );
  }
  if (failed) {
    throw failure;
  }
}

for (const mode of ["stdout", "stderr", "standalone"] as const) {
  test(`completed shell ${mode} pipes do not pin the host`, async (t) => {
    await retirementCase(t, mode);
  });
}
test(
  "completed shell drains late pipes and retains later-node cancellation",
  { skip: process.platform === "win32" },
  async (t) => {
    await retirementCase(t, "late-cancel");
  },
);
