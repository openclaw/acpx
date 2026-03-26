import { Position, type Edge, type Node } from "@xyflow/react";
import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
  FlowEdge,
  FlowNodeOutcome,
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
  kind: FlowStepRecord["kind"];
  status: ViewerNodeStatus;
  attempts: number;
  latestAttemptId?: string;
  durationLabel?: string;
  handleLabel?: string;
};

export type SelectedAttemptView = {
  step: FlowStepRecord;
  sessionRecord: SessionRecord | null;
  sessionEvents: FlowBundledSessionEvent[];
  sessionSlice: Array<{
    index: number;
    role: "user" | "agent" | "unknown";
    title: string;
    text: string;
    highlighted: boolean;
  }>;
  rawEventSlice: FlowBundledSessionEvent[];
  traceEvents: FlowTraceEvent[];
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
    const kind = bundle.flow.nodes[nodeId]?.kind ?? "compute";
    const attemptsForNode = bundle.steps.filter((step) => step.nodeId === nodeId);
    const visibleAttempt = findLatestVisibleAttempt(visibleSteps, nodeId);
    const status = deriveNodeStatus(nodeId, visibleAttempt, selectedStep);
    const level = levelByNode.get(nodeId) ?? 0;
    const column = nodesByLevel.get(level)?.indexOf(nodeId) ?? 0;
    const laneWidth = 310;
    const laneNodes = nodesByLevel.get(level) ?? [];
    const x = (column - (laneNodes.length - 1) / 2) * laneWidth;
    const y = level * 190;

    return {
      id: nodeId,
      type: "flowNode",
      data: {
        nodeId,
        kind,
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

  const sessionId = step.trace?.conversation?.sessionId ?? step.trace?.sessionId;
  const session = sessionId ? (bundle.sessions[sessionId] ?? null) : null;
  const sessionRecord = session?.record ?? null;
  const sessionEvents = session?.events ?? [];
  const conversation = step.trace?.conversation;
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
    sessionRecord,
    sessionEvents,
    sessionSlice,
    rawEventSlice,
    traceEvents,
  };
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
    return {
      index,
      role,
      title: role === "agent" ? "Agent" : role === "user" ? "User" : "Message",
      text: formatMessageText(message),
      highlighted:
        typeof start === "number" && typeof end === "number" && index >= start && index <= end,
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

function formatMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return String(message ?? "");
  }

  if ("User" in message) {
    return formatMessageEntry((message as { User?: { content?: unknown[] } }).User?.content);
  }
  if ("Agent" in message) {
    const agent = (message as { Agent?: { content?: unknown[]; tool_results?: unknown } }).Agent;
    const contentText = formatMessageEntry(agent?.content);
    if (
      !agent?.tool_results ||
      Object.keys(agent.tool_results as Record<string, unknown>).length === 0
    ) {
      return contentText;
    }
    return `${contentText}\n\nTool results:\n${JSON.stringify(agent.tool_results, null, 2)}`;
  }
  return JSON.stringify(message, null, 2);
}

function formatMessageEntry(content: unknown): string {
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content, null, 2);
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return String(part ?? "");
      }
      if ("Text" in part && typeof (part as { Text?: unknown }).Text === "string") {
        return (part as { Text: string }).Text;
      }
      return JSON.stringify(part, null, 2);
    })
    .join("\n\n");
}
