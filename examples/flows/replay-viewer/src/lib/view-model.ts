import { Position, type Edge, type Node } from "@xyflow/react";
import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
  FlowEdge,
  FlowNodeOutcome,
  FlowRunState,
  FlowStepRecord,
  FlowTraceEvent,
  LoadedRunBundle,
  SessionRecord,
} from "../types";

export type ViewerNodeStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ViewerNodeData = {
  nodeId: string;
  nodeType: FlowStepRecord["nodeType"];
  status: ViewerNodeStatus;
  attempts: number;
  latestAttemptId?: string;
  durationLabel?: string;
  handleLabel?: string;
};

export type SelectedAttemptView = {
  step: FlowStepRecord;
  sessionSourceStep: FlowStepRecord | null;
  sessionFromFallback: boolean;
  sessionRecord: SessionRecord | null;
  sessionEvents: FlowBundledSessionEvent[];
  sessionSlice: Array<{
    index: number;
    role: "user" | "agent" | "unknown";
    title: string;
    highlighted: boolean;
    textBlocks: string[];
    toolUses: Array<{
      id: string;
      name: string;
      summary: string;
      raw: unknown;
    }>;
    toolResults: Array<{
      id: string;
      toolName: string;
      status: string;
      preview: string;
      isError: boolean;
      raw: unknown;
    }>;
    hiddenPayloads: Array<{
      label: string;
      raw: unknown;
    }>;
  }>;
  rawEventSlice: FlowBundledSessionEvent[];
  traceEvents: FlowTraceEvent[];
};

export type RunOutcomeView = {
  status: FlowRunState["status"];
  headline: string;
  detail: string;
  accent: "ok" | "active" | "failed" | "timed_out";
  nodeId: string | null;
  attemptId: string | null;
  isTerminal: boolean;
};

export function buildGraph(
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
): {
  nodes: Node<ViewerNodeData>[];
  edges: Edge[];
} {
  const orderedNodeIds = layoutNodeIds(bundle.flow, bundle.steps);
  const selectedStep = bundle.steps[selectedStepIndex] ?? null;
  const visibleSteps = bundle.steps.slice(0, Math.max(selectedStepIndex + 1, 0));
  const actualTransitions = new Set<string>();

  for (let index = 1; index < visibleSteps.length; index += 1) {
    actualTransitions.add(`${visibleSteps[index - 1]?.nodeId}->${visibleSteps[index]?.nodeId}`);
  }

  const levelByNode = computeLevels(bundle.flow, orderedNodeIds);
  const nodesByLevel = new Map<number, string[]>();

  for (const nodeId of orderedNodeIds) {
    const level = levelByNode.get(nodeId) ?? 0;
    const existing = nodesByLevel.get(level) ?? [];
    existing.push(nodeId);
    nodesByLevel.set(level, existing);
  }

  const graphNodes = orderedNodeIds.map((nodeId) => {
    const nodeType = bundle.flow.nodes[nodeId]?.nodeType ?? "compute";
    const attemptsForNode = bundle.steps.filter((step) => step.nodeId === nodeId);
    const visibleAttempt = findLatestVisibleAttempt(visibleSteps, nodeId);
    const status = deriveNodeStatus(nodeId, visibleAttempt, selectedStep);
    const level = levelByNode.get(nodeId) ?? 0;
    const column = nodesByLevel.get(level)?.indexOf(nodeId) ?? 0;
    const laneWidth = 456;
    const laneNodes = nodesByLevel.get(level) ?? [];
    const x = (column - (laneNodes.length - 1) / 2) * laneWidth;
    const y = level * 284;

    return {
      id: nodeId,
      type: "flowNode",
      data: {
        nodeId,
        nodeType,
        status,
        attempts: attemptsForNode.length,
        latestAttemptId: visibleAttempt?.attemptId,
        durationLabel: visibleAttempt
          ? formatDuration(
              Date.parse(visibleAttempt.finishedAt) - Date.parse(visibleAttempt.startedAt),
            )
          : undefined,
        handleLabel: visibleAttempt?.session?.handle ?? bundle.flow.nodes[nodeId]?.session?.handle,
      },
      position: { x, y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: false,
      selectable: true,
    } satisfies Node<ViewerNodeData>;
  });

  const graphEdges = bundle.flow.edges.flatMap((edge, index) =>
    expandEdges(edge).map(({ target, label }, branchIndex) => {
      const edgeId = `${edge.from}->${target}-${index}-${branchIndex}`;
      const isTraversed = actualTransitions.has(`${edge.from}->${target}`);
      const isSelected = Boolean(
        selectedStep != null &&
        visibleSteps.at(-2)?.nodeId === edge.from &&
        selectedStep.nodeId === target,
      );

      return {
        id: edgeId,
        source: edge.from,
        target,
        type: "smoothstep",
        animated: isSelected,
        style: {
          stroke: isSelected
            ? "var(--edge-active)"
            : isTraversed
              ? "var(--edge-complete)"
              : "var(--edge-pending)",
          strokeWidth: isTraversed || isSelected ? 2.5 : 1.4,
          opacity: 1,
        },
        label,
        labelStyle: {
          fill: "var(--ink-soft)",
          fontSize: 11,
          fontWeight: 600,
        },
        labelBgStyle: {
          fill: "rgba(247, 244, 236, 0.9)",
        },
        markerEnd: {
          type: "arrowclosed",
          color: isSelected
            ? "var(--edge-active)"
            : isTraversed
              ? "var(--edge-complete)"
              : "var(--edge-pending)",
        },
      } satisfies Edge;
    }),
  );

  return {
    nodes: graphNodes,
    edges: graphEdges,
  };
}

export function selectAttemptView(
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
): SelectedAttemptView | null {
  const step = bundle.steps[selectedStepIndex];

  if (!step) {
    return null;
  }

  const sessionSourceStep = resolveSessionSourceStep(bundle.steps, selectedStepIndex);
  const sessionId =
    sessionSourceStep?.trace?.conversation?.sessionId ?? sessionSourceStep?.trace?.sessionId;
  const session = sessionId ? (bundle.sessions[sessionId] ?? null) : null;
  const sessionRecord = session?.record ?? null;
  const sessionEvents = session?.events ?? [];
  const conversation = sessionSourceStep?.trace?.conversation;
  const sessionSlice = createSessionSlice(
    sessionRecord,
    conversation?.messageStart,
    conversation?.messageEnd,
  );
  const rawEventSlice = createRawEventSlice(
    sessionEvents,
    conversation?.eventStartSeq,
    conversation?.eventEndSeq,
  );
  const traceEvents = bundle.trace.filter((event) => event.attemptId === step.attemptId);

  return {
    step,
    sessionSourceStep,
    sessionFromFallback:
      sessionSourceStep != null && sessionSourceStep.attemptId !== step.attemptId,
    sessionRecord,
    sessionEvents,
    sessionSlice,
    rawEventSlice,
    traceEvents,
  };
}

export function deriveRunOutcomeView(bundle: LoadedRunBundle): RunOutcomeView {
  const lastStep = bundle.steps.at(-1) ?? null;
  const activeNodeId =
    bundle.run.currentNode ?? bundle.live?.currentNode ?? lastStep?.nodeId ?? null;
  const activeAttemptId =
    bundle.run.currentAttemptId ?? bundle.live?.currentAttemptId ?? lastStep?.attemptId ?? null;
  const errorText =
    typeof bundle.run.error === "string" && bundle.run.error.trim().length > 0
      ? bundle.run.error.trim()
      : null;
  const waitingOn =
    typeof bundle.run.waitingOn === "string" && bundle.run.waitingOn.trim().length > 0
      ? bundle.run.waitingOn.trim()
      : null;

  switch (bundle.run.status) {
    case "completed":
      return {
        status: bundle.run.status,
        headline: "Run completed",
        detail: activeNodeId
          ? `The final recorded step completed at ${activeNodeId}.`
          : "The flow reached a completed terminal state.",
        accent: "ok",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
    case "running":
      return {
        status: bundle.run.status,
        headline: activeNodeId ? `Running at ${activeNodeId}` : "Run is still active",
        detail:
          bundle.run.statusDetail?.trim() ||
          "The run is still in progress. Replay position shows recorded attempts only.",
        accent: "active",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: false,
      };
    case "waiting":
      return {
        status: bundle.run.status,
        headline: waitingOn
          ? `Waiting at ${waitingOn}`
          : activeNodeId
            ? `Waiting at ${activeNodeId}`
            : "Run is waiting",
        detail:
          bundle.run.statusDetail?.trim() ||
          "The run paused at a checkpoint or external wait state.",
        accent: "active",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: false,
      };
    case "timed_out":
      return {
        status: bundle.run.status,
        headline: activeNodeId ? `Timed out at ${activeNodeId}` : "Run timed out",
        detail: errorText || "The run stopped because a node exceeded its timeout budget.",
        accent: "timed_out",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
    case "failed":
    default:
      return {
        status: bundle.run.status,
        headline: activeNodeId ? `Stopped at ${activeNodeId}` : "Run failed",
        detail:
          errorText ||
          "The run exited early because a node failed before reaching a completed terminal state.",
        accent: "failed",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
  }
}

function resolveSessionSourceStep(
  steps: FlowStepRecord[],
  selectedStepIndex: number,
): FlowStepRecord | null {
  const direct = steps[selectedStepIndex];
  if (direct?.trace?.conversation) {
    return direct;
  }

  for (let index = selectedStepIndex - 1; index >= 0; index -= 1) {
    const candidate = steps[index];
    if (candidate?.trace?.conversation || candidate?.session) {
      return candidate;
    }
  }

  if (direct?.session) {
    return direct;
  }

  return null;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs == null || Number.isNaN(durationMs)) {
    return "n/a";
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) {
    return "n/a";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function deriveNodeStatus(
  nodeId: string,
  visibleAttempt: FlowStepRecord | undefined,
  selectedStep: FlowStepRecord | null,
): ViewerNodeStatus {
  if (selectedStep?.nodeId === nodeId) {
    return "active";
  }
  if (!visibleAttempt) {
    return "queued";
  }
  return mapOutcomeToStatus(visibleAttempt.outcome);
}

function mapOutcomeToStatus(outcome: FlowNodeOutcome): ViewerNodeStatus {
  switch (outcome) {
    case "ok":
      return "completed";
    case "timed_out":
      return "timed_out";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "queued";
  }
}

function findLatestVisibleAttempt(
  steps: FlowStepRecord[],
  nodeId: string,
): FlowStepRecord | undefined {
  const matching = steps.filter((step) => step.nodeId === nodeId);
  return matching.at(-1);
}

function expandEdges(edge: FlowEdge): Array<{ target: string; label?: string }> {
  if ("to" in edge) {
    return [{ target: edge.to }];
  }
  return Object.entries(edge.switch.cases).map(([caseKey, target]) => ({
    target,
    label: caseKey,
  }));
}

function layoutNodeIds(flow: FlowDefinitionSnapshot, steps: FlowStepRecord[]): string[] {
  const stepOrder = Array.from(new Set(steps.map((step) => step.nodeId)));
  const queue = [flow.startAt];
  const visited = new Set<string>();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    ordered.push(nodeId);

    for (const edge of flow.edges) {
      if (edge.from !== nodeId) {
        continue;
      }
      if ("to" in edge) {
        queue.push(edge.to);
        continue;
      }
      for (const target of Object.values(edge.switch.cases)) {
        queue.push(target);
      }
    }
  }

  for (const nodeId of stepOrder) {
    if (!visited.has(nodeId)) {
      ordered.push(nodeId);
      visited.add(nodeId);
    }
  }

  for (const nodeId of Object.keys(flow.nodes).toSorted()) {
    if (!visited.has(nodeId)) {
      ordered.push(nodeId);
    }
  }

  return ordered;
}

function computeLevels(
  flow: FlowDefinitionSnapshot,
  orderedNodeIds: string[],
): Map<string, number> {
  const levelByNode = new Map<string, number>();
  levelByNode.set(flow.startAt, 0);

  for (const nodeId of orderedNodeIds) {
    const fromLevel = levelByNode.get(nodeId) ?? 0;

    for (const edge of flow.edges) {
      if (edge.from !== nodeId) {
        continue;
      }
      if ("to" in edge) {
        if (!levelByNode.has(edge.to)) {
          levelByNode.set(edge.to, fromLevel + 1);
        }
        continue;
      }
      for (const target of Object.values(edge.switch.cases)) {
        if (!levelByNode.has(target)) {
          levelByNode.set(target, fromLevel + 1);
        }
      }
    }
  }

  for (const nodeId of orderedNodeIds) {
    if (!levelByNode.has(nodeId)) {
      levelByNode.set(nodeId, levelByNode.size);
    }
  }

  return levelByNode;
}

function createSessionSlice(
  sessionRecord: SessionRecord | null,
  start: number | undefined,
  end: number | undefined,
): SelectedAttemptView["sessionSlice"] {
  const messages = Array.isArray(sessionRecord?.messages) ? sessionRecord.messages : [];
  return messages.map((message, index) => {
    const role = detectMessageRole(message);
    const contentView = describeMessage(message, role);
    return {
      index,
      role,
      title: role === "agent" ? "Agent" : role === "user" ? "User" : "Message",
      highlighted:
        typeof start === "number" && typeof end === "number" && index >= start && index <= end,
      textBlocks: contentView.textBlocks,
      toolUses: contentView.toolUses,
      toolResults: contentView.toolResults,
      hiddenPayloads: contentView.hiddenPayloads,
    };
  });
}

function createRawEventSlice(
  events: FlowBundledSessionEvent[],
  startSeq: number | undefined,
  endSeq: number | undefined,
): FlowBundledSessionEvent[] {
  if (typeof startSeq !== "number" || typeof endSeq !== "number") {
    return [];
  }
  return events.filter((event) => event.seq >= startSeq && event.seq <= endSeq);
}

function detectMessageRole(message: unknown): "user" | "agent" | "unknown" {
  if (message && typeof message === "object") {
    if ("User" in message) {
      return "user";
    }
    if ("Agent" in message) {
      return "agent";
    }
  }
  return "unknown";
}

function describeMessage(
  message: unknown,
  role: "user" | "agent" | "unknown",
): Pick<
  SelectedAttemptView["sessionSlice"][number],
  "textBlocks" | "toolUses" | "toolResults" | "hiddenPayloads"
> {
  if (!message || typeof message !== "object") {
    return {
      textBlocks: [String(message ?? "")].filter(Boolean),
      toolUses: [],
      toolResults: [],
      hiddenPayloads: [],
    };
  }

  if (role === "user") {
    const user = (message as { User?: { content?: unknown } }).User;
    return describeStructuredMessage(user?.content, undefined);
  }

  if (role === "agent") {
    const agent = (
      message as {
        Agent?: {
          content?: unknown;
          tool_results?: unknown;
        };
      }
    ).Agent;
    return describeStructuredMessage(agent?.content, agent?.tool_results);
  }

  return {
    textBlocks: [],
    toolUses: [],
    toolResults: [],
    hiddenPayloads: [{ label: "Raw message", raw: message }],
  };
}

function describeStructuredMessage(
  content: unknown,
  toolResults: unknown,
): Pick<
  SelectedAttemptView["sessionSlice"][number],
  "textBlocks" | "toolUses" | "toolResults" | "hiddenPayloads"
> {
  const textBlocks: string[] = [];
  const toolUses: SelectedAttemptView["sessionSlice"][number]["toolUses"] = [];
  const hiddenPayloads: SelectedAttemptView["sessionSlice"][number]["hiddenPayloads"] = [];

  if (Array.isArray(content)) {
    for (const [index, part] of content.entries()) {
      if (!part || typeof part !== "object") {
        const text = String(part ?? "").trim();
        if (text) {
          textBlocks.push(text);
        }
        continue;
      }

      if ("Text" in part && typeof (part as { Text?: unknown }).Text === "string") {
        const text = (part as { Text: string }).Text.trim();
        if (text) {
          textBlocks.push(text);
        }
        continue;
      }

      if ("ToolUse" in part) {
        const toolUse = (part as { ToolUse?: Record<string, unknown> }).ToolUse;
        if (toolUse && typeof toolUse === "object") {
          toolUses.push({
            id: String(toolUse.id ?? `tool-use-${index}`),
            name: typeof toolUse.name === "string" ? toolUse.name : "Tool call",
            summary: summarizeToolUse(toolUse),
            raw: toolUse,
          });
          continue;
        }
      }

      hiddenPayloads.push({
        label: `Structured content ${index + 1}`,
        raw: part,
      });
    }
  } else if (content != null) {
    hiddenPayloads.push({
      label: "Structured content",
      raw: content,
    });
  }

  return {
    textBlocks,
    toolUses,
    toolResults: describeToolResults(toolResults),
    hiddenPayloads,
  };
}

function describeToolResults(
  toolResults: unknown,
): SelectedAttemptView["sessionSlice"][number]["toolResults"] {
  if (!toolResults || typeof toolResults !== "object") {
    return [];
  }

  return Object.entries(toolResults as Record<string, unknown>).map(([id, entry]) => {
    const result = entry as {
      tool_name?: unknown;
      is_error?: unknown;
      output?: Record<string, unknown>;
      content?: unknown;
    };

    const toolName =
      typeof result.tool_name === "string" && result.tool_name.trim().length > 0
        ? result.tool_name
        : "Tool result";
    const preview = summarizeToolResult(result);
    const status =
      typeof result.output?.status === "string"
        ? result.output.status
        : result.is_error
          ? "error"
          : "completed";

    return {
      id,
      toolName,
      status,
      preview,
      isError: Boolean(result.is_error),
      raw: result,
    };
  });
}

function summarizeToolUse(toolUse: Record<string, unknown>): string {
  const parsed =
    parsePossiblyEncodedJson(toolUse.input) ?? parsePossiblyEncodedJson(toolUse.raw_input);
  const parsedCommand = findFirstParsedCommand(parsed);
  if (parsedCommand) {
    return parsedCommand;
  }
  const command = findShellCommand(parsed);
  if (command) {
    return command;
  }
  return "Structured input hidden by default";
}

function summarizeToolResult(result: {
  output?: Record<string, unknown>;
  content?: unknown;
}): string {
  const output = result.output ?? {};
  const preferredText = [
    typeof output.formatted_output === "string" ? output.formatted_output : null,
    typeof output.aggregated_output === "string" ? output.aggregated_output : null,
    typeof output.stderr === "string" && output.stderr.trim().length > 0 ? output.stderr : null,
    typeof output.stdout === "string" && output.stdout.trim().length > 0 ? output.stdout : null,
    extractTextFromToolContent(result.content),
  ].find((value): value is string => Boolean(value && value.trim().length > 0));

  if (!preferredText) {
    return "Structured result hidden by default";
  }

  const normalized = preferredText.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function parsePossiblyEncodedJson(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function findFirstParsedCommand(payload: Record<string, unknown> | null): string | null {
  const parsedCmd = payload?.parsed_cmd;
  if (!Array.isArray(parsedCmd) || parsedCmd.length === 0) {
    return null;
  }
  const first = parsedCmd[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") {
    return null;
  }
  const name = typeof first.name === "string" ? first.name : null;
  const cmd = typeof first.cmd === "string" ? first.cmd : null;
  if (name && cmd) {
    return `${name}: ${truncate(cmd, 96)}`;
  }
  if (cmd) {
    return truncate(cmd, 96);
  }
  return name;
}

function findShellCommand(payload: Record<string, unknown> | null): string | null {
  const command = payload?.command;
  if (!Array.isArray(command) || command.length === 0) {
    return null;
  }
  return truncate(
    command.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "),
    96,
  );
}

function extractTextFromToolContent(content: unknown): string | null {
  if (!content) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((entry) =>
        entry && typeof entry === "object" && "Text" in entry
          ? (entry as { Text?: unknown }).Text
          : null,
      )
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n");
    return text || null;
  }
  if (typeof content === "object" && "Text" in content) {
    const text = (content as { Text?: unknown }).Text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
