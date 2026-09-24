import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ShellActionResult } from "../../src/flows/types.js";
import { getOwnProcessIdentity, type ProcessBirthIdentity } from "../../src/process-identity.js";

export type RetirementMode = "stdout" | "stderr" | "standalone" | "late-cancel";
export type ReadyRecord = { nonce: string; pid: number; birth: ProcessBirthIdentity };
export type HostReport = {
  nonce: string;
  ending: string;
  result?: ShellActionResult;
};
export const EARLY_STDOUT = "early stdout\n";
export const EARLY_STDERR = "early stderr\n";

const [root, nonce, role, mode] = process.argv.slice(2);
assert.ok(root && nonce);
assert.ok(["host", "wrapper", "descendant"].includes(role));
assert.ok(["stdout", "stderr", "standalone", "late-cancel"].includes(mode));
const fixture = fileURLToPath(import.meta.url);

async function marked(name: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(root, name), "utf8")) === nonce;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function publish(name: string, value: unknown): Promise<void> {
  const temporary = path.join(root, `${name}.${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, path.join(root, name));
}

async function ready(): Promise<void> {
  const birth = await getOwnProcessIdentity();
  assert.ok(birth, "fixture must establish native process identity before readiness");
  await publish(`${role}.ready.json`, { nonce, pid: process.pid, birth });
}

function emergencyTimer(): NodeJS.Timeout {
  // Only W/C use this finite rescue ceiling; H has no forced-exit mechanism.
  return setTimeout(() => {
    writeFileSync(path.join(root, `${role}.emergency`), nonce);
    process.exit(90);
  }, 60_000);
}

async function writeOutput(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function runDescendant(): Promise<void> {
  const emergency = emergencyTimer();
  for (const [name, stream] of [
    ["stdout", process.stdout],
    ["stderr", process.stderr],
  ] as const) {
    stream.on("error", (error: Error) => {
      writeFileSync(
        path.join(root, `descendant.${name}.error.json`),
        JSON.stringify({ nonce, message: error.message }),
      );
    });
  }
  process.on("SIGINT", () => {
    writeFileSync(path.join(root, "descendant.sigint"), nonce);
    process.exit(0);
  });
  try {
    await ready();
    let wroteLate = false;
    let answered = false;
    while (!(await marked("stop"))) {
      if (!wroteLate && mode === "late-cancel" && (await marked("write-late"))) {
        wroteLate = true;
        try {
          // Each stream must drain substantially more than an ordinary pipe buffer.
          await writeOutput(process.stdout, "x".repeat(2 * 1024 * 1024));
          await writeOutput(process.stderr, "y".repeat(2 * 1024 * 1024));
          await publish("late-written.json", { nonce, ok: true, bytesPerStream: 2 * 1024 * 1024 });
        } catch (error) {
          await publish("late-written.json", {
            nonce,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!answered && (await marked("ping"))) {
        answered = true;
        await fs.writeFile(path.join(root, "pong"), nonce);
      }
      await delay(20);
    }
    await fs.writeFile(path.join(root, "descendant.stopping"), nonce);
  } finally {
    clearTimeout(emergency);
  }
}

async function runWrapper(): Promise<void> {
  const emergency = emergencyTimer();
  try {
    await ready();
    if (await marked("stop")) {
      return;
    }
    const child = spawn(process.execPath, [fixture, root, nonce, "descendant", mode], {
      stdio: [
        "ignore",
        mode === "stderr" ? "ignore" : "inherit",
        mode === "stdout" ? "ignore" : "inherit",
      ],
      windowsHide: true,
    });
    await once(child, "spawn");
    while (!(await marked("release-wrapper"))) {
      if (await marked("stop")) {
        return;
      }
      await delay(20);
    }
    await writeOutput(process.stdout, EARLY_STDOUT);
    await writeOutput(process.stderr, EARLY_STDERR);
    await fs.writeFile(path.join(root, "wrapper.exiting"), nonce);
    // The wrapper, deliberately, completes while its ready descendant stays alive.
    process.exit(0);
  } finally {
    clearTimeout(emergency);
  }
}

async function runHost(): Promise<void> {
  await ready();
  const execution = {
    command: process.execPath,
    args: [fixture, root, nonce, "wrapper", mode],
    timeoutMs: 0,
  };
  let result: ShellActionResult | undefined;
  let ending = "ok";
  let hold: NodeJS.Timeout | undefined;
  try {
    if (mode === "standalone") {
      const { runShellAction } = await import("../../src/flows/executors/shell.js");
      result = await runShellAction(execution);
    } else {
      const { FlowRunner, compute, defineFlow, shell } = await import("../../src/flows/runtime.js");
      const launch = shell({
        heartbeatMs: 0,
        timeoutMs: 0,
        exec: () => execution,
        parse: (value) => {
          result = value;
          return value;
        },
      });
      const waiting = compute({
        heartbeatMs: 0,
        timeoutMs: 0,
        run: async (context) => {
          const signal = context.signal;
          assert.ok(signal);
          // P1 deliberately has subsequent work; natural-exit cases never enter here.
          hold = setInterval(() => {}, 1_000);
          try {
            await publish("waiting.json", { nonce, result });
            signal.throwIfAborted();
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            signal.throwIfAborted();
          } finally {
            clearInterval(hold);
          }
        },
      });
      const runner = new FlowRunner({
        resolveAgent: () => ({ agentName: "synthetic", agentCommand: "unused", cwd: root }),
        permissionMode: "deny-all",
        outputRoot: path.join(root, "runs"),
        defaultNodeTimeoutMs: 0,
      });
      await runner.run(
        defineFlow({
          name: `shell-retirement-${mode}`,
          startAt: "launch",
          nodes: mode === "late-cancel" ? { launch, waiting } : { launch },
          edges: mode === "late-cancel" ? [{ from: "launch", to: "waiting" }] : [],
        }),
        {},
      );
    }
  } catch (error) {
    ending = error instanceof Error ? error.name : String(error);
    if (mode !== "late-cancel" || ending !== "InterruptedError") {
      process.exitCode = 1;
    }
  } finally {
    clearInterval(hold);
  }
  const report: HostReport = { nonce, ending, result };
  await publish("host-result.json", report);
  process.stdout.write(JSON.stringify(report) + "\n");
  // No host process.exit, unref, destroy, emergency timer, or remaining keepalive.
}

try {
  if (role === "host") {
    await runHost();
  } else if (role === "wrapper") {
    await runWrapper();
  } else {
    await runDescendant();
  }
} catch (error) {
  writeFileSync(
    path.join(root, `${role}.fatal.json`),
    JSON.stringify({ nonce, message: error instanceof Error ? error.message : String(error) }),
  );
  throw error;
}
