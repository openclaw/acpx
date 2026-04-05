import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { InterruptedError, TimeoutError } from "../async-control.js";
import { createOutputFormatter } from "../cli/output/output.js";
import { textPrompt } from "../prompt-content.js";
import { defaultSessionEventLog } from "../session/event-log.js";
import { SESSION_RECORD_SCHEMA } from "../types.js";
import type { PromptInput, SessionRecord } from "../types.js";
import type { FlowRunStore } from "./store.js";
import type {
  AcpNodeDefinition,
  FlowDefinition,
  FlowNodeContext,
  FlowNodeDefinition,
  FlowNodeOutcome,
  FlowNodeResult,
  FlowRunState,
  FlowSessionBinding,
  FlowStepTrace,
  ResolvedFlowAgent,
} from "./types.js";

type MemoryWritable = {
  write(chunk: string): void;
};

export function isoNow(): string {
  return new Date().toISOString();
}

export function persistRunFailure(
  store: FlowRunStore,
  runDir: string,
  state: FlowRunState,
  error: unknown,
): Promise<void> {
  if (
    state.finishedAt !== undefined &&
    (state.status === "failed" || state.status === "timed_out")
  ) {
    return Promise.resolve();
  }

  state.status = error instanceof TimeoutError ? "timed_out" : "failed";
  state.updatedAt = isoNow();
  state.finishedAt = state.updatedAt;
  state.error = error instanceof Error ? error.message : String(error);
  state.statusDetail = state.currentNode
    ? `Failed in ${state.currentNode}: ${state.error}`
    : state.error;
  return store.writeSnapshot(runDir, state, {
    scope: "run",
    type: "run_failed",
    payload: {
      status: state.status,
      error: state.error,
    },
  });
}

export function makeFlowNodeContext(
  state: FlowRunState,
  input: unknown,
  services: FlowNodeContext["services"],
): FlowNodeContext {
  return {
    input,
    outputs: state.outputs,
    results: state.results,
    state,
    services,
  };
}

export function markNodeStarted(
  state: FlowRunState,
  nodeId: string,
  attemptId: string,
  nodeType: FlowNodeDefinition["nodeType"],
  startedAt: string,
  detail?: string,
): void {
  state.status = "running";
  state.waitingOn = undefined;
  state.currentNode = nodeId;
  state.currentAttemptId = attemptId;
  state.currentNodeType = nodeType;
  state.currentNodeStartedAt = startedAt;
  state.lastHeartbeatAt = startedAt;
  state.statusDetail = detail ?? `Running ${nodeType} node ${nodeId}`;
}

export function clearActiveNode(state: FlowRunState, detail?: string): void {
  state.currentNode = undefined;
  state.currentAttemptId = undefined;
  state.currentNodeType = undefined;
  state.currentNodeStartedAt = undefined;
  state.lastHeartbeatAt = undefined;
  state.statusDetail = detail;
}

export function updateStatusDetail(state: FlowRunState, detail?: string): void {
  if (!detail) {
    return;
  }
  state.statusDetail = detail;
}

export async function finalizeStepTrace(
  store: FlowRunStore,
  runDir: string,
  state: FlowRunState,
  nodeId: string,
  attemptId: string,
  output: unknown,
  baseTrace: FlowStepTrace | null,
): Promise<FlowStepTrace | null> {
  const trace: FlowStepTrace = baseTrace ? structuredClone(baseTrace) : {};
  if (output !== undefined) {
    const inlineOutput = toInlineOutput(output);
    if (inlineOutput !== undefined) {
      trace.outputInline = inlineOutput;
    } else {
      trace.outputArtifact = await store.writeArtifact(runDir, state, output, {
        mediaType: outputArtifactMediaType(output),
        extension: outputArtifactExtension(output),
        nodeId,
        attemptId,
      });
    }
  }
  return Object.keys(trace).length > 0 ? trace : null;
}

export function normalizePromptInput(prompt: PromptInput | string): PromptInput {
  return typeof prompt === "string" ? textPrompt(prompt) : prompt;
}

export async function resolveNodeCwd(
  defaultCwd: string,
  cwd: AcpNodeDefinition["cwd"],
  context: FlowNodeContext,
): Promise<string> {
  if (typeof cwd === "function") {
    const resolved = (await cwd(context)) ?? defaultCwd;
    return path.resolve(defaultCwd, resolved);
  }
  return path.resolve(defaultCwd, cwd ?? defaultCwd);
}

export function resolveShellActionCwd(defaultCwd: string, cwd: string | undefined): string {
  return path.resolve(defaultCwd, cwd ?? defaultCwd);
}

export function summarizePrompt(promptText: string, explicitDetail?: string): string {
  if (explicitDetail) {
    return explicitDetail;
  }

  const line = promptText
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (!line) {
    return "Running ACP prompt";
  }

  const truncated = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return `ACP: ${truncated}`;
}

export function createQuietCaptureOutput(): {
  formatter: ReturnType<typeof createOutputFormatter>;
  read: () => string;
} {
  const chunks: string[] = [];
  const stdout: MemoryWritable = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };

  return {
    formatter: createOutputFormatter("quiet", {
      stdout,
    }),
    read: () => chunks.join("").trim(),
  };
}

export async function resolveFlowRunTitle(
  flow: FlowDefinition,
  input: unknown,
  flowPath?: string,
): Promise<string | undefined> {
  const titleDefinition = flow.run?.title;
  if (titleDefinition === undefined) {
    return undefined;
  }

  const resolved =
    typeof titleDefinition === "function"
      ? await Promise.resolve(titleDefinition({ input, flowName: flow.name, flowPath }))
      : titleDefinition;

  return normalizeFlowRunTitle(resolved);
}

export function normalizeFlowRunTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createRunId(flowName: string): string {
  const stamp = isoNow().replaceAll(":", "").replaceAll(".", "");
  const slug = flowName
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

export function createSessionBindingKey(agentCommand: string, cwd: string, handle: string): string {
  return `${agentCommand}::${cwd}::${handle}`;
}

export function createSessionName(
  flowName: string,
  handle: string,
  cwd: string,
  runId: string,
): string {
  const stamp = stableShortHash(cwd);
  return `${flowName}-${handle}-${stamp}-${runId.slice(-8)}`;
}

export function createSessionBundleId(handle: string, key: string): string {
  const safeHandle = handle
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${safeHandle || "session"}-${stableShortHash(key)}`;
}

export function createIsolatedSessionBinding(
  flowName: string,
  runId: string,
  attemptId: string,
  profile: string | undefined,
  agent: ResolvedFlowAgent,
): FlowSessionBinding {
  const key = `isolated::${attemptId}`;
  const handle = "isolated";
  return {
    key,
    handle,
    bundleId: createSessionBundleId(`${handle}-${attemptId}`, `${key}::${agent.cwd}`),
    name: `${flowName}-${attemptId}-${runId.slice(-8)}`,
    profile,
    agentName: agent.agentName,
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    acpxRecordId: key,
    acpSessionId: key,
  };
}

export function createSyntheticSessionRecord(options: {
  binding: FlowSessionBinding;
  createdAt: string;
  updatedAt: string;
  conversation: Pick<
    SessionRecord,
    "title" | "messages" | "updated_at" | "cumulative_token_usage" | "request_token_usage"
  >;
  acpxState: SessionRecord["acpx"] | undefined;
  lastSeq: number;
}): SessionRecord {
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: options.binding.acpxRecordId,
    acpSessionId: options.binding.acpSessionId,
    agentSessionId: options.binding.agentSessionId,
    agentCommand: options.binding.agentCommand,
    cwd: options.binding.cwd,
    name: options.binding.name,
    createdAt: options.createdAt,
    lastUsedAt: options.updatedAt,
    lastSeq: options.lastSeq,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(options.binding.acpxRecordId),
    closed: true,
    closedAt: options.updatedAt,
    title: options.conversation.title,
    messages: options.conversation.messages,
    updated_at: options.conversation.updated_at,
    cumulative_token_usage: options.conversation.cumulative_token_usage,
    request_token_usage: options.conversation.request_token_usage,
    acpx: options.acpxState,
  };
}

export function createNodeResult(options: {
  attemptId: string;
  nodeId: string;
  nodeType: FlowNodeDefinition["nodeType"];
  outcome: FlowNodeOutcome;
  startedAt: string;
  finishedAt: string;
  output?: unknown;
  error?: string;
}): FlowNodeResult {
  return {
    attemptId: options.attemptId,
    nodeId: options.nodeId,
    nodeType: options.nodeType,
    outcome: options.outcome,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    durationMs: new Date(options.finishedAt).getTime() - new Date(options.startedAt).getTime(),
    output: options.output,
    error: options.error,
  };
}

export function outcomeForError(error: unknown): FlowNodeOutcome {
  if (error instanceof TimeoutError) {
    return "timed_out";
  }
  if (error instanceof InterruptedError) {
    return "cancelled";
  }
  return "failed";
}

function stableShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

export function nextAttemptId(attemptCounts: Map<string, number>, nodeId: string): string {
  const next = (attemptCounts.get(nodeId) ?? 0) + 1;
  attemptCounts.set(nodeId, next);
  return `${nodeId}#${next}`;
}

export function createNodeOutcomePayload(
  result: FlowNodeResult,
  trace: FlowStepTrace | null,
): Record<string, unknown> {
  return {
    nodeType: result.nodeType,
    outcome: result.outcome,
    durationMs: result.durationMs,
    error: result.error ?? null,
    ...trace,
  };
}

export function attachStepTrace(error: unknown, trace: FlowStepTrace | null): Error {
  const attached =
    error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  (attached as Error & { flowStepTrace?: FlowStepTrace | null }).flowStepTrace = trace;
  return attached;
}

export function extractAttachedStepTrace(error: unknown): FlowStepTrace | null | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as Error & { flowStepTrace?: FlowStepTrace | null }).flowStepTrace;
}

function toInlineOutput(value: unknown): undefined | null | boolean | number | string | object {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 200 && !value.includes("\n") ? value : undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 200 && !serialized.includes("\n")) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function outputArtifactMediaType(value: unknown): string {
  return typeof value === "string" ? "text/plain" : "application/json";
}

function outputArtifactExtension(value: unknown): string {
  return typeof value === "string" ? "txt" : "json";
}

export function findConversationDeltaStart(
  before: SessionRecord["messages"],
  after: SessionRecord["messages"],
): number {
  const maxOverlap = Math.min(before.length, after.length);
  for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      const beforeMessage = before[before.length - overlap + index];
      const afterMessage = after[index];
      if (!deepEqualJson(beforeMessage, afterMessage)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return overlap;
    }
  }
  return 0;
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
