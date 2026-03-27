import { Position, type Edge, type Node } from "@xyflow/react";
import type {
  FlowBundledSessionEvent,
  FlowDefinitionSnapshot,
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
  title: string;
  subtitle: string;
  nodeType: FlowStepRecord["nodeType"];
  status: ViewerNodeStatus;
  attempts: number;
  latestAttemptId?: string;
  durationLabel?: string;
  isStart: boolean;
  isTerminal: boolean;
  isDecision: boolean;
  branchCount: number;
  branchLabels: string[];
  isRunOutcomeNode: boolean;
  runOutcomeLabel?: string;
  playbackProgress?: number;
};

export type PlaybackSegment = {
  stepIndex: number;
  nodeId: string;
  nodeType: FlowStepRecord["nodeType"];
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type PlaybackTimeline = {
  segments: PlaybackSegment[];
  totalDurationMs: number;
};

export type PlaybackPreview = {
  playheadMs: number;
  activeStepIndex: number;
  nearestStepIndex: number;
  stepProgress: number;
  stepStartMs: number;
  stepEndMs: number;
  totalDurationMs: number;
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

export type SessionListItemView = {
  id: string;
  label: string;
  sessionRecord: SessionRecord;
  sessionSlice: SelectedAttemptView["sessionSlice"];
  isStreamingSource: boolean;
};

export type RunOutcomeView = {
  status: FlowRunState["status"];
  headline: string;
  detail: string;
  shortLabel: string;
  accent: "ok" | "active" | "failed" | "timed_out";
  nodeId: string | null;
  attemptId: string | null;
  isTerminal: boolean;
};

type ExpandedFlowEdge = {
  source: string;
  target: string;
  edgeId: string;
};

type NodeSemantics = {
  startNodeId: string;
  terminalNodeIds: Set<string>;
  decisionNodeIds: Set<string>;
  outgoingTargets: Map<string, string[]>;
  outgoingLabels: Map<string, string[]>;
};

export function buildGraph(
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
  playback: PlaybackPreview | null = null,
): {
  nodes: Node<ViewerNodeData>[];
  edges: Edge[];
} {
  const orderedNodeIds = layoutNodeIds(bundle.flow, bundle.steps);
  const selectedStep = bundle.steps[selectedStepIndex] ?? null;
  const visibleSteps = bundle.steps.slice(0, Math.max(selectedStepIndex + 1, 0));
  const actualTransitions = new Set<string>();
  const semantics = inferNodeSemantics(bundle.flow);
  const expandedEdges = expandFlowEdges(bundle.flow);
  const provisionalLevels = computeShortestLevels(bundle.flow, expandedEdges, orderedNodeIds);
  const backEdgeIds = findBackEdgeIds(expandedEdges, provisionalLevels);
  const levelByNode = computeLevels(
    bundle.flow,
    orderedNodeIds,
    expandedEdges,
    backEdgeIds,
    semantics.terminalNodeIds,
  );
  const rankOrder = orderNodesWithinRanks(orderedNodeIds, expandedEdges, levelByNode, backEdgeIds);
  const runOutcome = deriveRunOutcomeView(bundle);

  for (let index = 1; index < visibleSteps.length; index += 1) {
    actualTransitions.add(`${visibleSteps[index - 1]?.nodeId}->${visibleSteps[index]?.nodeId}`);
  }

  const graphNodes = orderedNodeIds.map((nodeId) => {
    const nodeType = bundle.flow.nodes[nodeId]?.nodeType ?? "compute";
    const attemptsForNode = bundle.steps.filter((step) => step.nodeId === nodeId);
    const visibleAttempt = findLatestVisibleAttempt(visibleSteps, nodeId);
    const status = deriveNodeStatus(nodeId, visibleAttempt, selectedStep);
    const level = levelByNode.get(nodeId) ?? 0;
    const laneNodes = rankOrder.get(level) ?? [];
    const column = laneNodes.indexOf(nodeId);
    const laneWidth = 332;
    const x = (column - (laneNodes.length - 1) / 2) * laneWidth;
    const y = level * 236;
    const isStart = nodeId === semantics.startNodeId;
    const isTerminal = semantics.terminalNodeIds.has(nodeId);
    const isDecision = semantics.decisionNodeIds.has(nodeId);
    const branchCount = semantics.outgoingTargets.get(nodeId)?.length ?? 0;
    const branchLabels = semantics.outgoingLabels.get(nodeId) ?? [];

    return {
      id: nodeId,
      type: "flowNode",
      data: {
        nodeId,
        title: humanizeIdentifier(nodeId),
        subtitle: nodeId,
        nodeType,
        status,
        attempts: attemptsForNode.length,
        latestAttemptId: visibleAttempt?.attemptId,
        durationLabel: visibleAttempt
          ? formatDuration(
              Date.parse(visibleAttempt.finishedAt) - Date.parse(visibleAttempt.startedAt),
            )
          : undefined,
        isStart,
        isTerminal,
        isDecision,
        branchCount,
        branchLabels,
        isRunOutcomeNode: runOutcome.nodeId === nodeId,
        runOutcomeLabel:
          runOutcome.nodeId === nodeId && runOutcome.isTerminal ? runOutcome.shortLabel : undefined,
        playbackProgress:
          playback && selectedStep?.nodeId === nodeId ? clamp01(playback.stepProgress) : undefined,
      },
      position: { x, y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: false,
      selectable: true,
    } satisfies Node<ViewerNodeData>;
  });

  const graphEdges = expandedEdges.map((edge) => {
    const isTraversed = actualTransitions.has(`${edge.source}->${edge.target}`);
    const isSelected = Boolean(
      selectedStep != null &&
      visibleSteps.at(-2)?.nodeId === edge.source &&
      selectedStep.nodeId === edge.target,
    );
    const isBackEdge = backEdgeIds.has(edge.edgeId);
    const sourceNode = graphNodes.find((node) => node.id === edge.source);
    const targetNode = graphNodes.find((node) => node.id === edge.target);
    const leftToRight = (sourceNode?.position.x ?? 0) <= (targetNode?.position.x ?? 0);
    const stroke = isSelected
      ? "var(--edge-active)"
      : isTraversed
        ? "var(--edge-complete)"
        : "var(--edge-pending)";

    return {
      id: edge.edgeId,
      source: edge.source,
      target: edge.target,
      type: isBackEdge ? "smoothstep" : "step",
      sourceHandle: isBackEdge ? (leftToRight ? "out-right" : "out-left") : "out-bottom",
      targetHandle: isBackEdge ? (leftToRight ? "in-left" : "in-right") : "in-top",
      animated: isSelected,
      style: {
        stroke,
        strokeWidth: isSelected || isTraversed ? 2.4 : 1.2,
        opacity: isTraversed || isSelected ? 1 : 0.72,
        strokeDasharray: isBackEdge ? "6 5" : undefined,
      },
      markerEnd: {
        type: "arrowclosed",
        color: stroke,
      },
      zIndex: isBackEdge ? 0 : 1,
    } satisfies Edge;
  });

  return {
    nodes: graphNodes,
    edges: graphEdges,
  };
}

export function buildPlaybackTimeline(bundle: LoadedRunBundle): PlaybackTimeline {
  let cursorMs = 0;

  const segments = bundle.steps.map((step, stepIndex) => {
    const durationMs = estimatePlaybackDuration(bundle, stepIndex);
    const segment = {
      stepIndex,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      durationMs,
    } satisfies PlaybackSegment;
    cursorMs += durationMs;
    return segment;
  });

  return {
    segments,
    totalDurationMs: Math.max(cursorMs, 0),
  };
}

export function derivePlaybackPreview(
  timeline: PlaybackTimeline,
  playheadMs: number,
): PlaybackPreview | null {
  if (timeline.segments.length === 0) {
    return null;
  }

  const clampedPlayhead = clamp(playheadMs, 0, timeline.totalDurationMs);
  const lastSegment = timeline.segments.at(-1)!;
  const activeSegment =
    timeline.segments.find((segment) => clampedPlayhead < segment.endMs) ?? lastSegment;
  const durationMs = Math.max(activeSegment.durationMs, 1);
  const localProgress =
    activeSegment === lastSegment && clampedPlayhead >= timeline.totalDurationMs
      ? 1
      : clamp01((clampedPlayhead - activeSegment.startMs) / durationMs);

  return {
    playheadMs: clampedPlayhead,
    activeStepIndex: activeSegment.stepIndex,
    nearestStepIndex: findNearestStepIndex(timeline, clampedPlayhead),
    stepProgress: localProgress,
    stepStartMs: activeSegment.startMs,
    stepEndMs: activeSegment.endMs,
    totalDurationMs: timeline.totalDurationMs,
  };
}

export function playbackAnchorMs(timeline: PlaybackTimeline, stepIndex: number): number {
  const segment = timeline.segments[clamp(stepIndex, 0, Math.max(timeline.segments.length - 1, 0))];
  return segment?.endMs ?? 0;
}

export function revealConversationSlice(
  sessionSlice: SelectedAttemptView["sessionSlice"],
  progress: number,
): SelectedAttemptView["sessionSlice"] {
  const clampedProgress = clamp01(progress);
  if (clampedProgress >= 1) {
    return sessionSlice;
  }
  const revealed: SelectedAttemptView["sessionSlice"] = [];
  const totalWeight = countStreamedConversationChars(sessionSlice);

  if (totalWeight <= 0) {
    return sessionSlice.filter(isRevealableMessage);
  }

  let consumedWeight = 0;

  for (let index = 0; index < sessionSlice.length; index += 1) {
    const message = sessionSlice[index];
    if (!message) {
      break;
    }

    if (!isRevealableMessage(message)) {
      continue;
    }

    const messageWeight = messageRevealWeight(message);
    const start = consumedWeight / totalWeight;

    if (messageWeight <= 0) {
      if (clampedProgress >= start) {
        revealed.push(message);
        continue;
      }
      break;
    }

    const end = (consumedWeight + messageWeight) / totalWeight;
    if (clampedProgress >= end) {
      revealed.push(message);
      consumedWeight += messageWeight;
      continue;
    }

    if (clampedProgress < start) {
      break;
    }

    const charCount = messageWeight;
    const localProgress = clamp01(
      (clampedProgress - start) / Math.max(end - start, Number.EPSILON),
    );
    const partialTextBlocks =
      charCount > 0
        ? revealTextBlocks(message.textBlocks, Math.max(1, Math.round(charCount * localProgress)))
        : [];

    if (partialTextBlocks.length > 0 || (message.textBlocks.length === 0 && localProgress >= 1)) {
      revealed.push({
        ...message,
        textBlocks: partialTextBlocks,
        toolUses: [],
        toolResults: [],
        hiddenPayloads: [],
      });
    }
    break;
  }

  return revealed;
}

export function revealConversationTranscript(
  sessionSlice: SelectedAttemptView["sessionSlice"],
  progress: number,
): SelectedAttemptView["sessionSlice"] {
  const highlightedIndexes = sessionSlice
    .map((message, index) => (message.highlighted ? index : -1))
    .filter((index) => index >= 0);

  if (highlightedIndexes.length === 0) {
    return sessionSlice;
  }

  const firstHighlightedIndex = highlightedIndexes[0]!;
  const lastHighlightedIndex = highlightedIndexes.at(-1)!;
  const visiblePrefix = sessionSlice.slice(0, firstHighlightedIndex);
  const highlightedSlice = sessionSlice.slice(firstHighlightedIndex, lastHighlightedIndex + 1);
  const visibleHighlightedSlice = revealConversationSlice(highlightedSlice, progress);

  return [...visiblePrefix, ...visibleHighlightedSlice];
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

export function listSessionViews(
  bundle: LoadedRunBundle,
  selectedAttempt: SelectedAttemptView | null,
): SessionListItemView[] {
  const streamingSessionId =
    selectedAttempt?.sessionSourceStep?.trace?.conversation?.sessionId ??
    selectedAttempt?.sessionSourceStep?.trace?.sessionId ??
    null;
  const conversation = selectedAttempt?.sessionSourceStep?.trace?.conversation;

  return Object.values(bundle.sessions)
    .slice()
    .toSorted((left, right) =>
      (left.record.name ?? left.binding.name ?? left.id).localeCompare(
        right.record.name ?? right.binding.name ?? right.id,
      ),
    )
    .map((session) => ({
      id: session.id,
      label: session.record.name ?? session.binding.name ?? session.id,
      sessionRecord: session.record,
      sessionSlice: createSessionSlice(
        session.record,
        session.id === streamingSessionId ? conversation?.messageStart : undefined,
        session.id === streamingSessionId ? conversation?.messageEnd : undefined,
      ),
      isStreamingSource: session.id === streamingSessionId,
    }));
}

export function deriveRunOutcomeView(bundle: LoadedRunBundle): RunOutcomeView {
  const lastStep = bundle.steps.at(-1) ?? null;
  const activeNodeId =
    bundle.run.currentNode ?? bundle.live?.currentNode ?? lastStep?.nodeId ?? null;
  const activeNodeLabel = activeNodeId ? humanizeIdentifier(activeNodeId) : null;
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
        detail: activeNodeLabel
          ? `The final recorded step completed at ${activeNodeLabel}.`
          : "The flow reached a completed terminal state.",
        shortLabel: "completed",
        accent: "ok",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
    case "running":
      return {
        status: bundle.run.status,
        headline: activeNodeLabel ? `Running at ${activeNodeLabel}` : "Run is still active",
        detail:
          bundle.run.statusDetail?.trim() ||
          "The run is still in progress. Replay position shows recorded attempts only.",
        shortLabel: "running",
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
          : activeNodeLabel
            ? `Waiting at ${activeNodeLabel}`
            : "Run is waiting",
        detail:
          bundle.run.statusDetail?.trim() ||
          "The run paused at a checkpoint or external wait state.",
        shortLabel: "waiting",
        accent: "active",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: false,
      };
    case "timed_out":
      return {
        status: bundle.run.status,
        headline: activeNodeLabel ? `Timed out at ${activeNodeLabel}` : "Run timed out",
        detail: errorText || "The run stopped because a node exceeded its timeout budget.",
        shortLabel: "timed out",
        accent: "timed_out",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
    case "failed":
    default:
      return {
        status: bundle.run.status,
        headline: activeNodeLabel ? `Stopped at ${activeNodeLabel}` : "Run failed",
        detail:
          errorText ||
          "The run exited early because a node failed before reaching a completed terminal state.",
        shortLabel: "stopped",
        accent: "failed",
        nodeId: activeNodeId,
        attemptId: activeAttemptId,
        isTerminal: true,
      };
  }
}

export function humanizeIdentifier(value: string): string {
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bacp\b/gi, "ACP")
    .trim();

  if (!normalized) {
    return value;
  }

  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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

function estimatePlaybackDuration(bundle: LoadedRunBundle, stepIndex: number): number {
  const step = bundle.steps[stepIndex];
  if (!step) {
    return 800;
  }

  const actualDurationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt));
  const actualScaledMs = actualDurationMs > 0 ? Math.round(actualDurationMs / 8) : 0;

  if (step.nodeType === "acp") {
    const selected = selectAttemptView(bundle, stepIndex);
    const isDirectSession = selected?.sessionSourceStep?.attemptId === step.attemptId;
    const visibleChars = isDirectSession
      ? countStreamedConversationChars(selected.sessionSlice)
      : [step.promptText, step.rawText].reduce(
          (sum, value) => sum + (typeof value === "string" ? value.length : 0),
          0,
        );
    const revealDurationMs = 420 + visibleChars * 3;
    return clamp(Math.max(actualScaledMs, revealDurationMs), 700, 3_800);
  }

  const minimumMs = step.nodeType === "action" ? 850 : step.nodeType === "checkpoint" ? 650 : 700;
  const maximumMs = step.nodeType === "action" ? 3_000 : 2_400;
  return clamp(Math.max(actualScaledMs, minimumMs), minimumMs, maximumMs);
}

function findNearestStepIndex(timeline: PlaybackTimeline, playheadMs: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of timeline.segments) {
    const distance = Math.abs(segment.endMs - playheadMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = segment.stepIndex;
    }
  }

  return bestIndex;
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

function humanizeBranchLabel(value: string): string {
  const mapped = (
    {
      close_pr: "close",
      comment_and_escalate_to_human: "human",
      bug_or_feature: "classify",
      judge_initial_conflicts: "assess",
      resolve_initial_conflicts: "resolve",
      reproduce_bug_and_test_fix: "bug path",
      test_feature_directly: "feature path",
      judge_refactor: "refactor",
      collect_review_state: "review",
      do_superficial_refactor: "refactor",
      collect_ci_state: "ci",
      check_final_conflicts: "final conflicts",
      judge_final_conflicts: "assess",
      resolve_final_conflicts: "resolve",
      post_close_pr: "post close",
      post_escalation_comment: "post comment",
    } as Record<string, string | undefined>
  )[value];

  return mapped ?? humanizeIdentifier(value).toLowerCase();
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

function expandFlowEdges(flow: FlowDefinitionSnapshot): ExpandedFlowEdge[] {
  return flow.edges.flatMap((edge, index) => {
    if ("to" in edge) {
      return [
        {
          source: edge.from,
          target: edge.to,
          edgeId: `${edge.from}->${edge.to}-${index}-0`,
        },
      ];
    }

    return Object.values(edge.switch.cases).map((target, branchIndex) => ({
      source: edge.from,
      target,
      edgeId: `${edge.from}->${target}-${index}-${branchIndex}`,
    }));
  });
}

function inferNodeSemantics(flow: FlowDefinitionSnapshot): NodeSemantics {
  const outgoingTargets = new Map<string, string[]>();
  const outgoingLabels = new Map<string, string[]>();

  for (const edge of flow.edges) {
    const targets = "to" in edge ? [edge.to] : Object.values(edge.switch.cases);
    outgoingTargets.set(edge.from, [...(outgoingTargets.get(edge.from) ?? []), ...targets]);
    if ("switch" in edge) {
      outgoingLabels.set(edge.from, [
        ...(outgoingLabels.get(edge.from) ?? []),
        ...Object.keys(edge.switch.cases).map((caseKey) => humanizeBranchLabel(caseKey)),
      ]);
    }
  }

  const terminalNodeIds = new Set<string>();
  const decisionNodeIds = new Set<string>();

  for (const nodeId of Object.keys(flow.nodes)) {
    const targets = outgoingTargets.get(nodeId) ?? [];
    if (targets.length === 0) {
      terminalNodeIds.add(nodeId);
    }
    if (new Set(targets).size > 1) {
      decisionNodeIds.add(nodeId);
    }
  }

  return {
    startNodeId: flow.startAt,
    terminalNodeIds,
    decisionNodeIds,
    outgoingTargets,
    outgoingLabels,
  };
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
  expandedEdges: ExpandedFlowEdge[],
  backEdgeIds: Set<string>,
  terminalNodeIds: Set<string>,
): Map<string, number> {
  const forwardEdges = expandedEdges.filter((edge) => !backEdgeIds.has(edge.edgeId));
  const topologicalOrder = computeTopologicalOrder(orderedNodeIds, forwardEdges);
  const longestFromStart = computeLongestLevels(flow.startAt, topologicalOrder, forwardEdges);
  const tailDepths = computeTailDepths(orderedNodeIds, forwardEdges, terminalNodeIds);
  const levelByNode = new Map<string, number>();
  let fallbackLevel = Math.max(...longestFromStart.values(), 0);

  for (const nodeId of orderedNodeIds) {
    const baseLevel = longestFromStart.get(nodeId);
    if (baseLevel == null) {
      fallbackLevel += 1;
      levelByNode.set(nodeId, fallbackLevel);
      continue;
    }
    levelByNode.set(nodeId, baseLevel);
  }

  const maxLevel = Math.max(...levelByNode.values(), 0);

  for (const nodeId of orderedNodeIds) {
    const tailDepth = tailDepths.get(nodeId);
    if (tailDepth == null) {
      continue;
    }
    const currentLevel = levelByNode.get(nodeId) ?? 0;
    levelByNode.set(nodeId, Math.max(currentLevel, maxLevel - tailDepth));
  }

  return levelByNode;
}

function computeTopologicalOrder(
  orderedNodeIds: string[],
  forwardEdges: ExpandedFlowEdge[],
): string[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const nodeId of orderedNodeIds) {
    indegree.set(nodeId, 0);
    outgoing.set(nodeId, []);
  }

  for (const edge of forwardEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const queue = orderedNodeIds.filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0);
  const visited = new Set<string>();
  const order: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    order.push(nodeId);

    for (const target of outgoing.get(nodeId) ?? []) {
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) {
        queue.push(target);
      }
    }
  }

  for (const nodeId of orderedNodeIds) {
    if (!visited.has(nodeId)) {
      order.push(nodeId);
    }
  }

  return order;
}

function computeLongestLevels(
  startNodeId: string,
  topologicalOrder: string[],
  forwardEdges: ExpandedFlowEdge[],
): Map<string, number> {
  const levels = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  levels.set(startNodeId, 0);

  for (const edge of forwardEdges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  for (const nodeId of topologicalOrder) {
    const fromLevel = levels.get(nodeId);
    if (fromLevel == null) {
      continue;
    }

    for (const target of outgoing.get(nodeId) ?? []) {
      levels.set(target, Math.max(levels.get(target) ?? -1, fromLevel + 1));
    }
  }

  return levels;
}

function computeTailDepths(
  orderedNodeIds: string[],
  forwardEdges: ExpandedFlowEdge[],
  terminalNodeIds: Set<string>,
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const memo = new Map<string, number | null>();

  for (const edge of forwardEdges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  function visit(nodeId: string): number | null {
    if (memo.has(nodeId)) {
      return memo.get(nodeId)!;
    }
    if (terminalNodeIds.has(nodeId)) {
      memo.set(nodeId, 0);
      return 0;
    }
    const targets = outgoing.get(nodeId) ?? [];
    if (targets.length !== 1) {
      memo.set(nodeId, null);
      return null;
    }
    const childDepth = visit(targets[0]!);
    const depth = childDepth == null ? null : childDepth + 1;
    memo.set(nodeId, depth);
    return depth;
  }

  for (const nodeId of orderedNodeIds) {
    visit(nodeId);
  }

  return new Map(
    Array.from(memo.entries()).filter((entry): entry is [string, number] => entry[1] != null),
  );
}

function computeShortestLevels(
  flow: FlowDefinitionSnapshot,
  expandedEdges: ExpandedFlowEdge[],
  orderedNodeIds: string[],
): Map<string, number> {
  const levels = new Map<string, number>();
  levels.set(flow.startAt, 0);

  for (const nodeId of orderedNodeIds) {
    const sourceLevel = levels.get(nodeId);
    if (sourceLevel == null) {
      continue;
    }

    for (const edge of expandedEdges) {
      if (edge.source !== nodeId) {
        continue;
      }
      const nextLevel = sourceLevel + 1;
      const current = levels.get(edge.target);
      if (current == null || nextLevel < current) {
        levels.set(edge.target, nextLevel);
      }
    }
  }

  return levels;
}

function findBackEdgeIds(
  expandedEdges: ExpandedFlowEdge[],
  shortestLevels: Map<string, number>,
): Set<string> {
  const backEdgeIds = new Set<string>();

  for (const edge of expandedEdges) {
    const sourceLevel = shortestLevels.get(edge.source);
    const targetLevel = shortestLevels.get(edge.target);
    if (sourceLevel == null || targetLevel == null) {
      continue;
    }
    if (targetLevel <= sourceLevel) {
      backEdgeIds.add(edge.edgeId);
    }
  }

  return backEdgeIds;
}

function orderNodesWithinRanks(
  orderedNodeIds: string[],
  expandedEdges: ExpandedFlowEdge[],
  levelByNode: Map<string, number>,
  backEdgeIds: Set<string>,
): Map<number, string[]> {
  const ranks = new Map<number, string[]>();
  const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const parentOrder = new Map<string, number>();

  for (const nodeId of orderedNodeIds) {
    const level = levelByNode.get(nodeId) ?? 0;
    const existing = ranks.get(level) ?? [];
    existing.push(nodeId);
    ranks.set(level, existing);
  }

  const maxLevel = Math.max(...ranks.keys());
  for (let level = 0; level <= maxLevel; level += 1) {
    const nodes = ranks.get(level) ?? [];
    nodes.sort((left, right) => {
      const leftScore = computeParentBarycenter(
        left,
        expandedEdges,
        levelByNode,
        parentOrder,
        backEdgeIds,
      );
      const rightScore = computeParentBarycenter(
        right,
        expandedEdges,
        levelByNode,
        parentOrder,
        backEdgeIds,
      );
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0);
    });
    nodes.forEach((nodeId, index) => {
      parentOrder.set(nodeId, index);
    });
  }

  return ranks;
}

function computeParentBarycenter(
  nodeId: string,
  expandedEdges: ExpandedFlowEdge[],
  levelByNode: Map<string, number>,
  parentOrder: Map<string, number>,
  backEdgeIds: Set<string>,
): number {
  const parents = expandedEdges
    .filter(
      (edge) =>
        edge.target === nodeId &&
        !backEdgeIds.has(edge.edgeId) &&
        (levelByNode.get(edge.source) ?? 0) < (levelByNode.get(nodeId) ?? 0),
    )
    .map((edge) => parentOrder.get(edge.source))
    .filter((value): value is number => typeof value === "number");

  if (parents.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  return parents.reduce((sum, value) => sum + value, 0) / parents.length;
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

function countStreamedConversationChars(sessionSlice: SelectedAttemptView["sessionSlice"]): number {
  return sessionSlice.reduce((sum, message) => sum + messageRevealWeight(message), 0);
}

function isRevealableMessage(message: SelectedAttemptView["sessionSlice"][number]): boolean {
  return (
    message.textBlocks.length > 0 ||
    message.toolUses.length > 0 ||
    message.toolResults.length > 0 ||
    message.hiddenPayloads.length > 0
  );
}

function messageRevealWeight(message: SelectedAttemptView["sessionSlice"][number]): number {
  if (message.role !== "agent") {
    return 0;
  }
  return message.textBlocks.reduce((sum, block) => sum + block.length, 0);
}

function revealTextBlocks(textBlocks: string[], charBudget: number): string[] {
  const revealed: string[] = [];
  let remainingChars = Math.max(0, charBudget);

  for (const block of textBlocks) {
    if (remainingChars <= 0) {
      break;
    }
    const take = Math.min(block.length, remainingChars);
    revealed.push(block.slice(0, take));
    remainingChars -= take;
    if (take < block.length) {
      break;
    }
  }

  return revealed.filter((value) => value.length > 0);
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
