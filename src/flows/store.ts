import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FlowRunState } from "./types.js";

export type FlowStoreEvent = Record<string, unknown>;

export function flowRunsBaseDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "flows", "runs");
}

export class FlowRunStore {
  readonly outputRoot: string;

  constructor(outputRoot: string = flowRunsBaseDir()) {
    this.outputRoot = outputRoot;
  }

  async createRunDir(runId: string): Promise<string> {
    const runDir = path.join(this.outputRoot, runId);
    await fs.mkdir(runDir, { recursive: true });
    return runDir;
  }

  async writeSnapshot(runDir: string, state: FlowRunState, event: FlowStoreEvent): Promise<void> {
    state.updatedAt = isoNow();
    await writeJsonAtomic(path.join(runDir, "run.json"), state);
    await writeJsonAtomic(path.join(runDir, "live.json"), createLiveState(state));
    await appendEvent(runDir, event);
  }

  async writeLive(runDir: string, state: FlowRunState, event: FlowStoreEvent): Promise<void> {
    state.updatedAt = isoNow();
    await writeJsonAtomic(path.join(runDir, "live.json"), createLiveState(state));
    await appendEvent(runDir, event);
  }
}

type FlowLiveState = {
  runId: string;
  flowName: string;
  flowPath?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: FlowRunState["status"];
  currentNode?: string;
  currentNodeKind?: FlowRunState["currentNodeKind"];
  currentNodeStartedAt?: string;
  lastHeartbeatAt?: string;
  statusDetail?: string;
  waitingOn?: string;
  error?: string;
  sessionBindings: FlowRunState["sessionBindings"];
};

function createLiveState(state: FlowRunState): FlowLiveState {
  return {
    runId: state.runId,
    flowName: state.flowName,
    flowPath: state.flowPath,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    updatedAt: state.updatedAt,
    status: state.status,
    currentNode: state.currentNode,
    currentNodeKind: state.currentNodeKind,
    currentNodeStartedAt: state.currentNodeStartedAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    statusDetail: state.statusDetail,
    waitingOn: state.waitingOn,
    error: state.error,
    sessionBindings: state.sessionBindings,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  await fs.writeFile(tempPath, `${payload}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function appendEvent(runDir: string, event: FlowStoreEvent): Promise<void> {
  await fs.appendFile(
    path.join(runDir, "events.ndjson"),
    `${JSON.stringify({ at: isoNow(), ...event })}\n`,
    "utf8",
  );
}

function isoNow(): string {
  return new Date().toISOString();
}
