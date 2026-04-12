import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpJsonRpcMessage, AcpMessageDirection, SessionRecord } from "../types.js";
import type {
  AcpNodeDefinition,
  FlowArtifactRef,
  FlowDefinition,
  FlowDefinitionSnapshot,
  FlowManifestSessionEntry,
  FlowNodeDefinition,
  FlowRunManifest,
  FlowRunState,
  FlowSessionBinding,
  FlowTraceEvent,
  FlowTraceEventDraft,
} from "./types.js";

const FLOW_BUNDLE_SCHEMA = "acpx.flow-run-bundle.v1" as const;
const FLOW_TRACE_SCHEMA = "acpx.flow-trace-event.v1" as const;
const FLOW_SNAPSHOT_SCHEMA = "acpx.flow-definition-snapshot.v1" as const;

const MANIFEST_PATH = "manifest.json";
const FLOW_SNAPSHOT_PATH = "flow.json";
const TRACE_PATH = "trace.ndjson";
const PROJECTIONS_DIR = "projections";
const RUN_PROJECTION_PATH = "projections/run.json";
const LIVE_PROJECTION_PATH = "projections/live.json";
const STEPS_PROJECTION_PATH = "projections/steps.json";
const SESSIONS_DIR = "sessions";
const ARTIFACTS_DIR = "artifacts";

type FlowLiveState = {
  runId: string;
  flowName: string;
  runTitle?: string;
  flowPath?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  status: FlowRunState["status"];
  currentNode?: string;
  currentAttemptId?: string;
  currentNodeType?: FlowRunState["currentNodeType"];
  currentNodeStartedAt?: string;
  lastHeartbeatAt?: string;
  statusDetail?: string;
  waitingOn?: string;
  error?: string;
  sessionBindings: FlowRunState["sessionBindings"];
};

type WriteArtifactOptions = {
  mediaType: string;
  extension: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  emitTrace?: boolean;
};

export function flowRunsBaseDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "flows", "runs");
}

export class FlowRunStore {
  readonly outputRoot: string;
  private readonly traceSeqByRun = new Map<string, number>();
  private readonly sessionSeqByBundle = new Map<string, number>();
  private readonly manifestByRun = new Map<string, FlowRunManifest>();
  private readonly appendChainByPath = new Map<string, Promise<void>>();

  constructor(outputRoot: string = flowRunsBaseDir()) {
    this.outputRoot = outputRoot;
  }

  async createRunDir(runId: string): Promise<string> {
    const runDir = path.join(this.outputRoot, runId);
    await fs.mkdir(path.join(runDir, PROJECTIONS_DIR), { recursive: true });
    await fs.mkdir(path.join(runDir, SESSIONS_DIR), { recursive: true });
    await fs.mkdir(path.join(runDir, ARTIFACTS_DIR), { recursive: true });
    this.traceSeqByRun.set(runDir, 0);
    return runDir;
  }

  async initializeRunBundle(
    runDir: string,
    options: {
      flow: FlowDefinition;
      state: FlowRunState;
      inputArtifact?: FlowArtifactRef;
    },
  ): Promise<void> {
    const snapshot = createFlowDefinitionSnapshot(options.flow);
    const manifest: FlowRunManifest = {
      schema: FLOW_BUNDLE_SCHEMA,
      runId: options.state.runId,
      flowName: options.state.flowName,
      runTitle: options.state.runTitle,
      flowPath: options.state.flowPath,
      startedAt: options.state.startedAt,
      finishedAt: options.state.finishedAt,
      status: options.state.status,
      traceSchema: FLOW_TRACE_SCHEMA,
      paths: {
        flow: FLOW_SNAPSHOT_PATH,
        trace: TRACE_PATH,
        runProjection: RUN_PROJECTION_PATH,
        liveProjection: LIVE_PROJECTION_PATH,
        stepsProjection: STEPS_PROJECTION_PATH,
        sessionsDir: SESSIONS_DIR,
        artifactsDir: ARTIFACTS_DIR,
      },
      sessions: [],
    };

    this.manifestByRun.set(runDir, manifest);
    await writeJsonAtomic(this.resolveRunPath(runDir, FLOW_SNAPSHOT_PATH), snapshot);
    await writeJsonAtomic(this.resolveRunPath(runDir, MANIFEST_PATH), manifest);
    await writeJsonAtomic(this.resolveRunPath(runDir, RUN_PROJECTION_PATH), options.state);
    await writeJsonAtomic(
      this.resolveRunPath(runDir, LIVE_PROJECTION_PATH),
      createLiveState(options.state),
    );
    await writeJsonAtomic(this.resolveRunPath(runDir, STEPS_PROJECTION_PATH), options.state.steps);
    await ensureFile(this.resolveRunPath(runDir, TRACE_PATH));

    await this.appendTrace(runDir, options.state, {
      scope: "run",
      type: "run_started",
      payload: {
        flowName: options.state.flowName,
        ...(options.state.runTitle ? { runTitle: options.state.runTitle } : {}),
        ...(options.state.flowPath ? { flowPath: options.state.flowPath } : {}),
        ...(options.inputArtifact ? { inputArtifact: options.inputArtifact } : {}),
      },
    });
  }

  async writeSnapshot(
    runDir: string,
    state: FlowRunState,
    event: FlowTraceEventDraft,
  ): Promise<void> {
    state.updatedAt = isoNow();
    await writeJsonAtomic(this.resolveRunPath(runDir, RUN_PROJECTION_PATH), state);
    await writeJsonAtomic(
      this.resolveRunPath(runDir, LIVE_PROJECTION_PATH),
      createLiveState(state),
    );
    await writeJsonAtomic(this.resolveRunPath(runDir, STEPS_PROJECTION_PATH), state.steps);
    await this.writeManifest(runDir, state);
    await this.appendTrace(runDir, state, event);
  }

  async writeLive(runDir: string, state: FlowRunState, event: FlowTraceEventDraft): Promise<void> {
    state.updatedAt = isoNow();
    await writeJsonAtomic(
      this.resolveRunPath(runDir, LIVE_PROJECTION_PATH),
      createLiveState(state),
    );
    await this.writeManifest(runDir, state);
    await this.appendTrace(runDir, state, event);
  }

  async appendTrace(
    runDir: string,
    state: FlowRunState,
    event: FlowTraceEventDraft,
  ): Promise<FlowTraceEvent> {
    const traceEvent: FlowTraceEvent = {
      seq: this.nextTraceSeq(runDir),
      at: isoNow(),
      runId: state.runId,
      ...event,
    };
    await this.appendJsonLine(this.resolveRunPath(runDir, TRACE_PATH), traceEvent);
    return traceEvent;
  }

  async writeArtifact(
    runDir: string,
    state: FlowRunState,
    content: unknown,
    options: WriteArtifactOptions,
  ): Promise<FlowArtifactRef> {
    const buffer = toArtifactBuffer(content, options.mediaType);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const relativePath = path.posix.join(
      ARTIFACTS_DIR,
      `sha256-${sha256}${normalizeArtifactExtension(options.extension)}`,
    );
    const filePath = this.resolveRunPath(runDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, buffer);
    }

    const artifact: FlowArtifactRef = {
      path: relativePath,
      mediaType: options.mediaType,
      bytes: buffer.byteLength,
      sha256,
    };
    if (options.emitTrace !== false) {
      await this.appendTrace(runDir, state, {
        scope: "artifact",
        type: "artifact_written",
        nodeId: options.nodeId,
        attemptId: options.attemptId,
        sessionId: options.sessionId,
        artifact,
        payload: {
          artifact,
        },
      });
    }
    return artifact;
  }

  async ensureSessionBundle(
    runDir: string,
    state: FlowRunState,
    binding: FlowSessionBinding,
    record?: SessionRecord,
  ): Promise<void> {
    const sessionDir = this.resolveRunPath(runDir, sessionDirPath(binding.bundleId));
    await fs.mkdir(sessionDir, { recursive: true });
    await writeJsonAtomic(path.join(sessionDir, "binding.json"), binding);
    await ensureFile(path.join(sessionDir, "events.ndjson"));
    if (record) {
      await this.writeSessionRecord(runDir, state, binding, record);
    }

    const manifest = this.getManifest(runDir, state);
    const existing = manifest.sessions.find((entry) => entry.id === binding.bundleId);
    const isNew = !existing;
    if (isNew) {
      const entry: FlowManifestSessionEntry = {
        id: binding.bundleId,
        handle: binding.handle,
        bindingPath: path.posix.join(sessionDirPath(binding.bundleId), "binding.json"),
        recordPath: path.posix.join(sessionDirPath(binding.bundleId), "record.json"),
        eventsPath: path.posix.join(sessionDirPath(binding.bundleId), "events.ndjson"),
      };
      manifest.sessions.push(entry);
      await writeJsonAtomic(this.resolveRunPath(runDir, MANIFEST_PATH), manifest);
    }

    if (isNew) {
      await this.appendTrace(runDir, state, {
        scope: "session",
        type: "session_bound",
        sessionId: binding.bundleId,
        payload: {
          sessionId: binding.bundleId,
          handle: binding.handle,
          bindingArtifact: {
            path: path.posix.join(sessionDirPath(binding.bundleId), "binding.json"),
            mediaType: "application/json",
            sha256: await fileSha256(path.join(sessionDir, "binding.json")),
          },
        },
      });
    }
  }

  async writeSessionRecord(
    runDir: string,
    _state: FlowRunState,
    binding: FlowSessionBinding,
    record: SessionRecord,
  ): Promise<void> {
    const bundleSeq = this.sessionSeqByBundle.get(`${runDir}::${binding.bundleId}`) ?? 0;
    const bundledRecord = createBundledSessionRecord(binding, record, bundleSeq);
    await writeJsonAtomic(
      this.resolveRunPath(runDir, path.posix.join(sessionDirPath(binding.bundleId), "record.json")),
      bundledRecord,
    );
  }

  async appendSessionEvent(
    runDir: string,
    binding: FlowSessionBinding,
    direction: AcpMessageDirection,
    message: AcpJsonRpcMessage,
  ): Promise<number> {
    const sessionKey = `${runDir}::${binding.bundleId}`;
    const seq = (this.sessionSeqByBundle.get(sessionKey) ?? 0) + 1;
    this.sessionSeqByBundle.set(sessionKey, seq);
    await this.appendJsonLine(
      this.resolveRunPath(
        runDir,
        path.posix.join(sessionDirPath(binding.bundleId), "events.ndjson"),
      ),
      {
        seq,
        at: isoNow(),
        direction,
        message,
      },
    );
    return seq;
  }

  private getManifest(runDir: string, state: FlowRunState): FlowRunManifest {
    const existing = this.manifestByRun.get(runDir);
    if (existing) {
      existing.startedAt = state.startedAt;
      existing.finishedAt = state.finishedAt;
      existing.status = state.status;
      existing.flowPath = state.flowPath;
      existing.flowName = state.flowName;
      existing.runTitle = state.runTitle;
      return existing;
    }

    const created: FlowRunManifest = {
      schema: FLOW_BUNDLE_SCHEMA,
      runId: state.runId,
      flowName: state.flowName,
      runTitle: state.runTitle,
      flowPath: state.flowPath,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      status: state.status,
      traceSchema: FLOW_TRACE_SCHEMA,
      paths: {
        flow: FLOW_SNAPSHOT_PATH,
        trace: TRACE_PATH,
        runProjection: RUN_PROJECTION_PATH,
        liveProjection: LIVE_PROJECTION_PATH,
        stepsProjection: STEPS_PROJECTION_PATH,
        sessionsDir: SESSIONS_DIR,
        artifactsDir: ARTIFACTS_DIR,
      },
      sessions: [],
    };
    this.manifestByRun.set(runDir, created);
    return created;
  }

  private async writeManifest(runDir: string, state: FlowRunState): Promise<void> {
    const manifest = this.getManifest(runDir, state);
    await writeJsonAtomic(this.resolveRunPath(runDir, MANIFEST_PATH), manifest);
  }

  private nextTraceSeq(runDir: string): number {
    const next = (this.traceSeqByRun.get(runDir) ?? 0) + 1;
    this.traceSeqByRun.set(runDir, next);
    return next;
  }

  private resolveRunPath(runDir: string, relativePath: string): string {
    return path.join(runDir, ...relativePath.split("/"));
  }

  private async appendJsonLine(filePath: string, value: unknown): Promise<void> {
    const prior = this.appendChainByPath.get(filePath) ?? Promise.resolve();
    const nextWrite = prior.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
    });
    const tracked = nextWrite.finally(() => {
      if (this.appendChainByPath.get(filePath) === tracked) {
        this.appendChainByPath.delete(filePath);
      }
    });
    this.appendChainByPath.set(filePath, tracked);
    await tracked;
  }
}

function createLiveState(state: FlowRunState): FlowLiveState {
  return {
    runId: state.runId,
    flowName: state.flowName,
    runTitle: state.runTitle,
    flowPath: state.flowPath,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    updatedAt: state.updatedAt,
    status: state.status,
    currentNode: state.currentNode,
    currentAttemptId: state.currentAttemptId,
    currentNodeType: state.currentNodeType,
    currentNodeStartedAt: state.currentNodeStartedAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    statusDetail: state.statusDetail,
    waitingOn: state.waitingOn,
    error: state.error,
    sessionBindings: state.sessionBindings,
  };
}

function createFlowDefinitionSnapshot(flow: FlowDefinition): FlowDefinitionSnapshot {
  return {
    schema: FLOW_SNAPSHOT_SCHEMA,
    name: flow.name,
    ...(flow.run?.title !== undefined ? { run: { hasTitle: true } } : {}),
    ...(flow.permissions ? { permissions: structuredClone(flow.permissions) } : {}),
    startAt: flow.startAt,
    nodes: Object.fromEntries(
      Object.entries(flow.nodes).map(([nodeId, node]) => [nodeId, snapshotNode(node)]),
    ),
    edges: structuredClone(flow.edges),
  };
}

function snapshotNode(node: FlowNodeDefinition): FlowDefinitionSnapshot["nodes"][string] {
  const common = {
    nodeType: node.nodeType,
    ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    ...(node.heartbeatMs !== undefined ? { heartbeatMs: node.heartbeatMs } : {}),
    ...(node.statusDetail ? { statusDetail: node.statusDetail } : {}),
  };

  switch (node.nodeType) {
    case "acp":
      return {
        ...common,
        ...(node.profile ? { profile: node.profile } : {}),
        session: {
          ...(node.session?.handle ? { handle: node.session.handle } : {}),
          ...(node.session?.isolated ? { isolated: true } : {}),
        },
        cwd: snapshotCwd(node.cwd),
        hasPrompt: true,
        hasParse: typeof node.parse === "function",
      };
    case "compute":
      return {
        ...common,
        hasRun: true,
      };
    case "action": {
      const actionExecution: "shell" | "function" = "exec" in node ? "shell" : "function";
      return {
        ...common,
        actionExecution,
        hasRun: "run" in node,
        hasExec: "exec" in node,
        hasParse: "parse" in node && typeof node.parse === "function",
      };
    }
    case "checkpoint":
      return {
        ...common,
        ...(node.summary ? { summary: node.summary } : {}),
        hasRun: typeof node.run === "function",
      };
  }

  throw new Error(`Unsupported flow node type: ${String(node satisfies never)}`);
}

function snapshotCwd(cwd: AcpNodeDefinition["cwd"]): {
  mode: "default" | "static" | "dynamic";
  value?: string;
} {
  if (typeof cwd === "function") {
    return { mode: "dynamic" };
  }
  if (typeof cwd === "string") {
    return { mode: "static", value: cwd };
  }
  return { mode: "default" };
}

function createBundledSessionRecord(
  binding: FlowSessionBinding,
  record: SessionRecord,
  bundleLastSeq: number,
): SessionRecord {
  return {
    ...structuredClone(record),
    lastSeq: bundleLastSeq,
    eventLog: {
      ...structuredClone(record.eventLog),
      active_path: path.posix.join(sessionDirPath(binding.bundleId), "events.ndjson"),
      segment_count: 1,
      max_segments: 1,
    },
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${payload}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function ensureFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, "", "utf8");
}

async function fileSha256(filePath: string): Promise<string> {
  const payload = await fs.readFile(filePath);
  return createHash("sha256").update(payload).digest("hex");
}

function toArtifactBuffer(content: unknown, mediaType: string): Buffer {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (mediaType === "application/json") {
    return Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf8");
  }
  return Buffer.from(String(content), "utf8");
}

function normalizeArtifactExtension(extension: string): string {
  if (!extension) {
    return "";
  }
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function sessionDirPath(bundleId: string): string {
  return path.posix.join(SESSIONS_DIR, bundleId);
}

function isoNow(): string {
  return new Date().toISOString();
}
