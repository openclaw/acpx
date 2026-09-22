import assert from "node:assert/strict";
import childProcess, {
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateQueueOwnerForSession } from "../../src/session/queue/lease-store.js";
import { queueLockFilePath } from "../../src/session/queue/paths.js";
import { settleRetirerHelpers } from "./queue-retirement-retry.js";

export type SnapshotCase =
  | "bounded"
  | "missing-self"
  | "root-replaced"
  | "new-custody"
  | "publication-failure"
  | "batch-error"
  | "missing"
  | "poll";
export type SnapshotReport = {
  code?: string | number;
  events: { name: string; pid?: number; pids?: number[]; time: number }[];
  signals: number[];
  queries: (number | null)[];
  guardBirths: (string | null)[];
  alive: number[];
  retained: boolean;
  originalPreserved: boolean;
};

async function runCase(mode: SnapshotCase, count: number): Promise<void> {
  assert.equal(process.platform, "win32");
  const birth = "2026-09-21T10:00:00.0000000Z";
  const selfBirth = "2026-09-21T09:00:00.0000000Z";
  const replacement = "2026-09-21T11:00:00.0000000Z";
  const root = 2_000_001;
  assert(process.pid < root || process.pid > root + count);
  const pids = Array.from({ length: count }, (_, index) => root + index + 1);
  const retained = !["bounded", "missing-self", "root-replaced"].includes(mode);
  const alive = new Set(retained ? pids : [root, ...pids]);
  const births = new Map([root, ...pids].map((pid) => [pid, birth]));
  const reparented = new Set<number>();
  const sessionId = "snapshot-retirement";
  const lock = queueLockFilePath(sessionId);
  const witness = (pid: number) => ({
    pid,
    processIdentity: { kind: "windows-creation", value: birth },
  });
  const lateChild = mode === "new-custody" || mode === "publication-failure";
  const owner = {
    ...witness(root),
    sessionId,
    ownerGeneration: 17,
    socketPath: "unused",
    createdAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    queueDepth: 0,
    ...(retained
      ? {
          retirement: {
            ownerGeneration: 17,
            root: witness(root),
            descendants: (lateChild ? pids.slice(0, 1) : pids).map(witness),
          },
        }
      : {}),
  };
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const original = JSON.stringify(owner);
  await fs.writeFile(lock, original);
  const report: SnapshotReport = {
    events: [],
    signals: [],
    queries: [],
    guardBirths: [],
    alive: [],
    retained: true,
    originalPreserved: true,
  };
  const clock = performance.now.bind(performance);
  let charged = 0;
  Object.defineProperty(performance, "now", { value: () => clock() + charged });
  const event = (name: string, extra: { pid?: number; pids?: number[] } = {}) => {
    report.events.push({ name, ...extra, time: performance.now() });
  };
  const guard = () => {
    const payload = JSON.parse(readFileSync(`${lock}.guard`, "utf8")) as {
      pid: number;
      processIdentity?: { value: string };
    };
    assert.equal(payload.pid, process.pid);
    report.guardBirths.push(payload.processIdentity?.value ?? null);
  };
  const execFile = childProcess.execFile.bind(childProcess);
  const kill = process.kill.bind(process);
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const helpers: { child: ChildProcess; closed: Promise<void> }[] = [];
  childProcess.execFile = ((
    command: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    let source: string;
    const query = path.win32.basename(command).toLowerCase() === "powershell.exe";
    const pid = /-Filter 'ProcessId = (\d+)'/.exec(args.at(-1) ?? "")?.[1];
    if (query) {
      report.queries.push(pid ? Number(pid) : null);
      event("query", pid ? { pid: Number(pid) } : {});
      const rows = [process.pid, root, ...pids]
        .filter((id) => {
          if (pid && id !== Number(pid)) return false;
          if (id === process.pid) return mode !== "missing-self";
          return alive.has(id) && !(mode === "missing" && id === pids[0]);
        })
        .map((id) => {
          const parent = id === process.pid || id === root || reparented.has(id) ? 0 : id - 1;
          return `${id} ${parent} 0 S ${id === process.pid ? selfBirth : births.get(id)}`;
        });
      source = `process.stdout.write(${JSON.stringify(rows.join("\n"))})`;
    } else {
      assert.equal(path.win32.basename(command).toLowerCase(), "taskkill.exe");
      guard();
      event("taskkill", { pid: root });
      // The root exits successfully while recorded children survive independently.
      alive.delete(root);
      source = "process.exit(0)";
    }
    const child = execFile(process.execPath, ["-e", source], options, (error, stdout, stderr) => {
      if (query) charged += 1_250;
      callback(error, stdout, stderr);
    });
    helpers.push({ child, closed: new Promise((resolve) => child.once("close", () => resolve())) });
    return child;
  }) as typeof childProcess.execFile;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    // Synthetic PIDs never reach the OS; helper cleanup uses owned child handles.
    if (pid < root || pid > root + count) return kill(pid, signal);
    if (!alive.has(pid)) {
      throw Object.assign(new Error("fixture process is gone"), { code: "ESRCH" });
    }
    if (signal === 0) return true;
    assert.equal(signal, "SIGKILL");
    guard();
    event("signal", { pid });
    report.signals.push(pid);
    if (mode === "batch-error" && pid === pids.at(-1)) {
      // A continuation microtask must not interleave another member's signal.
      queueMicrotask(() => event("after-error-microtask"));
      throw Object.assign(new Error("fixture signal refused"), { code: "EPERM" });
    }
    if (mode !== "poll") alive.delete(pid);
    return true;
  }) as typeof process.kill;
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === lock) {
      guard();
      const next = JSON.parse(readFileSync(args[0], "utf8")) as {
        retirement: { descendants: { pid: number }[] };
      };
      const captured = next.retirement.descendants.map(({ pid }) => pid);
      event("publication", { pids: captured });
      if (mode === "publication-failure") {
        throw Object.assign(new Error("new custody publication refused"), { code: "EIO" });
      }
      if (mode === "root-replaced") births.set(root, replacement);
      if (mode === "new-custody" && captured.includes(pids[1])) {
        births.set(pids[1], replacement);
        reparented.add(pids[1]);
      }
    }
    await rename(...args);
  };
  fs.unlink = async (...args: Parameters<typeof fs.unlink>) => {
    if (args[0] === lock) {
      guard();
      event("unlink");
    }
    await unlink(...args);
  };
  syncBuiltinESMExports();
  try {
    await terminateQueueOwnerForSession(sessionId);
  } catch (error) {
    const failure = error as { detailCode?: string; code?: string | number };
    report.code = failure.detailCode ?? failure.code ?? "unexpected";
  } finally {
    await settleRetirerHelpers(helpers);
  }
  report.alive = [...alive];
  const final = await fs.readFile(lock, "utf8").catch(() => undefined);
  report.retained = final !== undefined;
  report.originalPreserved = final === original;
  process.stdout.write(JSON.stringify(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCase(process.argv[2] as SnapshotCase, Number(process.argv[3]));
}
