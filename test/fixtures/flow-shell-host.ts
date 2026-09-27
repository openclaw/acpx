import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InterruptedError } from "../../src/async-control.js";
import {
  getOwnProcessIdentity,
  observeProcessIncarnation,
  type ProcessBirthIdentity,
} from "../../src/process-identity.js";

export type FlowHostMode =
  | "interrupt"
  | "late-executor"
  | "background"
  | "wrapper-exit"
  | "one-interrupt";
export type ActorRecord = { role: string; pid: number; birth: ProcessBirthIdentity };
type FixtureFailure = "readiness" | "body" | "publication";
export type FlowHostReport = {
  dir: string;
  actors: ActorRecord[];
  result?: Record<string, unknown>;
  primaryError?: string;
  cleaned: boolean;
};
export const HOST_STOP = "acpx-test-flow-host-stop";
const JOIN_MS = 10_000;

export async function bounded<T>(pending: Promise<T>, label: string, ms = JOIN_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function actorStopped(actor: ActorRecord): Promise<boolean> {
  if ((await observeProcessIncarnation(actor.pid, actor.birth)) === "gone") {
    return true;
  }
  const observed = spawnSync("ps", ["-p", String(actor.pid), "-o", "stat="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.ifError(observed.error);
  return observed.status === 1 || observed.stdout.trim().startsWith("Z");
}

export async function runActor(dir: string, role: string, body: () => void): Promise<void> {
  // Emergency exits contain broken fixtures, and always leave failure evidence.
  setTimeout(() => {
    writeFileSync(path.join(dir, `${role}.expired`), "expired");
    process.exit(90);
  }, 30_000);
  setInterval(() => {
    if (existsSync(path.join(dir, "rescue"))) {
      writeFileSync(path.join(dir, `${role}.rescued`), "rescued");
      process.exit(91);
    }
  }, 20);
  const birth = await getOwnProcessIdentity();
  assert.ok(birth, "synthetic actor must establish its native birth identity");
  writeFileSync(
    path.join(dir, `${role}.actor.tmp`),
    JSON.stringify({ role, pid: process.pid, birth }),
  );
  renameSync(path.join(dir, `${role}.actor.tmp`), path.join(dir, `${role}.actor.json`));
  if (existsSync(path.join(dir, "rescue"))) {
    writeFileSync(path.join(dir, `${role}.rescued`), "rescued");
    process.exit(91);
  }
  body();
}

function actorScript(dir: string, role: string, body: string): string {
  return `import(${JSON.stringify(import.meta.url)}).then(({runActor})=>runActor(${JSON.stringify(dir)},${JSON.stringify(role)},()=>{${body}}))`;
}

async function readActors(dir: string): Promise<ActorRecord[]> {
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".actor.json"));
  return await Promise.all(
    files.map(
      async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as ActorRecord,
    ),
  );
}

async function waitForPid(file: string): Promise<number> {
  for (let i = 0; i < 250; i += 1) {
    try {
      const value = Number(await fs.readFile(file, "utf8"));
      if (Number.isInteger(value) && value > 1) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error("descendant did not start");
}

function scripts(dir: string, mode: FlowHostMode, failure?: FixtureFailure) {
  const pidFile = path.join(dir, "pid");
  const marker = path.join(dir, "signal");
  const publish =
    failure === "readiness"
      ? ""
      : `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`;
  const mark = (value: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},${value});`;
  let body: string;
  if (mode === "wrapper-exit") {
    const descendant = actorScript(
      dir,
      "descendant",
      `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});${publish}setInterval(()=>{},1000)`,
    );
    body = `process.on('SIGINT',()=>{${mark("'SIGINT'")}process.exit(0)});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true});setInterval(()=>{},1000)`;
  } else if (mode === "background") {
    const descendant = actorScript(
      dir,
      "descendant",
      `process.on('SIGINT',()=>{${mark("'SIGINT'")}process.exit(0)});${publish}setInterval(()=>{},1000)`,
    );
    body = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.exit(0)`;
  } else if (mode === "one-interrupt") {
    body = `let count=0;process.on('SIGINT',()=>{if(++count>1)process.exit(2);setTimeout(()=>{${mark("String(count)")}process.exit(0)},200)});${publish}setInterval(()=>{},1000)`;
  } else if (mode === "late-executor") {
    body = `${mark("'launched'")}process.exit(0)`;
  } else {
    body = `process.on('SIGINT',()=>{${mark("'SIGINT'")}process.exit(0)});process.on('SIGTERM',()=>{});${publish}setInterval(()=>{},1000)`;
  }
  return {
    script: mode === "late-executor" ? body : actorScript(dir, "wrapper", body),
    pidFile,
    marker,
  };
}

export async function runFlowHostCase(
  mode: FlowHostMode,
  failure?: FixtureFailure,
  bodyError?: Error,
): Promise<void> {
  const { FlowRunner, compute, defineFlow, shell } = await import("../../src/flows/runtime.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-host-"));
  const { script, pidFile, marker } = scripts(dir, mode, failure);
  const report: FlowHostReport = { dir, actors: [], cleaned: false };
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runDir: string | undefined;
  const runner = new FlowRunner({
    resolveAgent: () => ({ agentName: "unused", agentCommand: "unused", cwd: dir }),
    permissionMode: "deny-all",
    outputRoot: dir,
  });
  const launch = shell({
    timeoutMs: 0,
    exec: async (context) => {
      runDir = path.join(dir, context.state.runId);
      if (mode === "late-executor") {
        entered();
        await gate;
      }
      return { command: process.execPath, args: ["-e", script], timeoutMs: 0 };
    },
  });
  const flow = defineFlow({
    name: mode,
    startAt: "work",
    nodes: {
      work: launch,
      ...(mode === "background"
        ? {
            waiting: compute({
              timeoutMs: 0,
              run: () => {
                entered();
                return new Promise(() => {});
              },
            }),
          }
        : {}),
    },
    edges: mode === "background" ? [{ from: "work", to: "waiting" }] : [],
  });
  let settled = false;
  const pending = runner
    .run(flow, {})
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      settled = true;
    });
  let interrupted = false;
  const interrupt = async () => {
    if (settled || interrupted) {
      return;
    }
    // A setup failure can precede FlowRunner's asynchronous listener installation.
    await bounded(
      (async () => {
        while (process.listenerCount("SIGINT") === 0) {
          if (settled) {
            return;
          }
          await delay(10);
        }
      })(),
      "flow interrupt readiness",
    );
    if (!settled && !interrupted) {
      interrupted = true;
      process.kill(
        mode === "interrupt" || mode === "late-executor" ? process.pid : -process.pid,
        "SIGINT",
      );
    }
  };
  const waitForInterruption = async (label: string): Promise<InterruptedError> => {
    const outcome = await bounded(pending, label);
    if (outcome.ok) {
      throw new Error("Flow completed without the expected interruption", { cause: outcome.value });
    }
    if (!(outcome.error instanceof InterruptedError)) {
      throw outcome.error;
    }
    assert.ok(interrupted, "flow must reject after the fixture's actual interrupt");
    return outcome.error;
  };
  let stop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const onStop = (message: unknown) => {
    if (message === HOST_STOP) {
      stop(new Error("host result deadline exceeded"));
    }
  };
  process.on("message", onStop);
  process.channel?.unref();
  let failed = false;
  let primary: unknown;
  try {
    report.result = await Promise.race([
      (async () => {
        if (mode === "late-executor" || mode === "background") {
          await bounded(ready, "executor readiness");
        }
        if (mode !== "late-executor") {
          await waitForPid(pidFile);
        }
        if (failure === "publication") {
          assert.ok(runDir);
          const projection = path.join(runDir, "projections", "run.json");
          await fs.rm(projection);
          await fs.mkdir(projection);
        }
        if (failure === "body" || failure === "publication") {
          throw bodyError ?? new Error("synthetic body failure");
        }
        await interrupt();
        const error = await waitForInterruption("interrupted flow");
        if (mode === "late-executor") {
          release();
          await delay(100);
          return { error: error.name, launched: existsSync(marker) };
        }
        const received = await fs.readFile(marker, "utf8");
        if (mode === "one-interrupt") {
          return { error: error.name, count: received };
        }
        if (mode === "background") {
          return { error: error.name, received: received === "SIGINT" };
        }
        const actors = await readActors(dir);
        const alive = (await Promise.all(actors.map(actorStopped))).some((value) => !value);
        return mode === "interrupt"
          ? { error: error.name, alive, sigintReceived: received }
          : { error: error.name, alive, handled: received };
      })(),
      stopped,
    ]);
  } catch (error) {
    failed = true;
    primary = error;
    report.primaryError = error instanceof Error ? error.message : String(error);
  }
  try {
    await interrupt();
    await waitForInterruption("flow cleanup");
    release();
    report.actors = await readActors(dir);
    for (const actor of report.actors) {
      assert.ok(await actorStopped(actor), `${actor.role} is still live after flow cleanup`);
    }
    assert.ok(
      !(await fs.readdir(dir)).some((name) => /\.(?:expired|rescued)$/.test(name)),
      "synthetic actor needed emergency cleanup",
    );
    await fs.rm(dir, { recursive: true, force: true });
    report.cleaned = true;
  } catch (cleanupError) {
    // Cooperative containment is task-directory scoped; never signal a saved PID.
    const errors = failed ? [primary, cleanupError] : [cleanupError];
    let retired = false;
    try {
      report.actors = await readActors(dir);
      retired = (await Promise.all(report.actors.map(actorStopped))).every(Boolean);
    } catch (observationError) {
      errors.push(observationError);
    }
    if (!settled || !retired) {
      try {
        await fs.writeFile(path.join(dir, "rescue"), "stop");
        await bounded(
          (async () => {
            while ((await Promise.all(report.actors.map(actorStopped))).some((value) => !value)) {
              await delay(20);
            }
          })(),
          "synthetic actor rescue",
        );
      } catch (rescueError) {
        errors.push(rescueError);
      }
    }
    throw new AggregateError(errors, `Flow fixture cleanup failed; retained ${dir}`, {
      cause: cleanupError,
    });
  } finally {
    process.off("message", onStop);
    process.stdout.write(JSON.stringify(report));
  }
  if (failed) {
    throw primary;
  }
}
