import { Position, type Edge, type Node } from "@xyflow/react";
import type {
  ELK as ElkEngine,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
} from "elkjs/lib/elk.bundled.js";
import type {
  FlowDefinitionSnapshot,
  FlowNodeOutcome,
  FlowStepRecord,
  LoadedRunBundle,
} from "../types.js";
import { formatDuration, humanizeIdentifier } from "./view-model-format.js";
import type {
  PlaybackPreview,
  RunOutcomeView,
  ViewerEdgeData,
  ViewerGraphLayout,
  ViewerNodeData,
  ViewerNodeStatus,
} from "./view-model-types.js";

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

const ELK_NODE_WIDTH = 264;
const ELK_NODE_BASE_HEIGHT = 132;
const ELK_BRANCH_ROW_HEIGHT = 26;
let elkPromise: Promise<ElkEngine> | null = null;

export function buildGraph(
  bundle: LoadedRunBundle,
  selectedStepIndex: number,
  playback: PlaybackPreview | null = null,
  layout: ViewerGraphLayout | null = null,
): {
  nodes: Node<ViewerNodeData>[];
  edges: Edge<ViewerEdgeData>[];
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
  const runOutcome = deriveRunOutcomeView(bundle);
  const terminalSelectionSettled = isSettledTerminalSelection(
    bundle,
    selectedStep,
    runOutcome,
    semantics.terminalNodeIds,
    playback,
  );
  const fallbackRankOrder = orderNodesWithinRanks(
    orderedNodeIds,
    expandedEdges,
    levelByNode,
    backEdgeIds,
  );

  for (let index = 1; index < visibleSteps.length; index += 1) {
    actualTransitions.add(`${visibleSteps[index - 1]?.nodeId}->${visibleSteps[index]?.nodeId}`);
  }

  const graphNodes = orderedNodeIds.map((nodeId) => {
    const nodeType = bundle.flow.nodes[nodeId]?.nodeType ?? "compute";
    const attemptsForNode = bundle.steps.filter((step) => step.nodeId === nodeId);
    const visibleAttempt = findLatestVisibleAttempt(visibleSteps, nodeId);
    const status = deriveNodeStatus(nodeId, visibleAttempt, selectedStep, terminalSelectionSettled);
    const fallbackPosition = deriveFallbackNodePosition(nodeId, levelByNode, fallbackRankOrder);
    const layoutPosition = layout?.nodePositions[nodeId];
    const x = layoutPosition?.x ?? fallbackPosition.x;
    const y = layoutPosition?.y ?? fallbackPosition.y;
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
        runOutcomeAccent:
          runOutcome.nodeId === nodeId && runOutcome.isTerminal ? runOutcome.accent : undefined,
        playbackProgress:
          playback && selectedStep?.nodeId === nodeId && !terminalSelectionSettled
            ? clamp01(playback.stepProgress)
            : undefined,
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
      !terminalSelectionSettled &&
      selectedStep != null &&
      visibleSteps.at(-2)?.nodeId === edge.source &&
      selectedStep.nodeId === edge.target,
    );
    const isBackEdge = backEdgeIds.has(edge.edgeId);
    const stroke = isSelected
      ? "var(--edge-active)"
      : isTraversed
        ? "var(--edge-complete)"
        : "var(--edge-pending)";
    const routedPoints = layout?.edgeRoutes[edge.edgeId]?.points;

    return {
      id: edge.edgeId,
      source: edge.source,
      target: edge.target,
      type: "routedFlow",
      animated: isSelected,
      data: {
        points: routedPoints,
        isBackEdge,
      },
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
    } satisfies Edge<ViewerEdgeData>;
  });

  return {
    nodes: graphNodes,
    edges: graphEdges,
  };
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

export async function buildGraphLayout(
  flow: FlowDefinitionSnapshot,
): Promise<ViewerGraphLayout | null> {
  const orderedNodeIds = layoutNodeIds(flow, []);
  const semantics = inferNodeSemantics(flow);
  const expandedEdges = expandFlowEdges(flow);
  const shortestLevels = computeShortestLevels(flow, expandedEdges, orderedNodeIds);
  const backEdgeIds = findBackEdgeIds(expandedEdges, shortestLevels);
  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "PREFER_NODES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.unnecessaryBendpoints": "true",
      "elk.padding": "[top=48,left=72,bottom=72,right=72]",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.spacing.edgeNode": "42",
      "elk.spacing.edgeEdge": "24",
    },
    children: orderedNodeIds.map((nodeId, index) => {
      const branchLabels = semantics.outgoingLabels.get(nodeId) ?? [];
      const layoutOptions: Record<string, string> = {
        "elk.priority": `${1000 - index}`,
      };
      if (semantics.terminalNodeIds.has(nodeId)) {
        layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
      } else if (nodeId === flow.startAt) {
        layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
      }
      return {
        id: nodeId,
        width: ELK_NODE_WIDTH,
        height: estimateElkNodeHeight(branchLabels.length),
        layoutOptions,
      } satisfies ElkNode;
    }),
    edges: expandedEdges.map((edge, index) => {
      const layoutOptions: Record<string, string> = backEdgeIds.has(edge.edgeId)
        ? {
            "elk.layered.priority.direction": "1",
          }
        : {
            "elk.priority": `${1000 - index}`,
          };
      return {
        id: edge.edgeId,
        sources: [edge.source],
        targets: [edge.target],
        layoutOptions,
      };
    }) satisfies ElkExtendedEdge[],
  };

  try {
    const elk = await getElk();
    const layout = await elk.layout(elkGraph);
    const nodePositions: ViewerGraphLayout["nodePositions"] = {};
    const edgeRoutes: ViewerGraphLayout["edgeRoutes"] = {};

    for (const child of layout.children ?? []) {
      nodePositions[child.id] = {
        x: child.x ?? 0,
        y: child.y ?? 0,
      };
    }

    for (const edge of layout.edges ?? []) {
      const points = extractElkEdgePoints(edge);
      if (points.length === 0) {
        continue;
      }
      edgeRoutes[edge.id] = {
        points,
        isBackEdge: backEdgeIds.has(edge.id),
      };
    }

    return {
      nodePositions,
      edgeRoutes,
    };
  } catch {
    return null;
  }
}

async function getElk(): Promise<ElkEngine> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(({ default: Elk }) => new Elk());
  }
  return elkPromise;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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
  terminalSelectionSettled: boolean,
): ViewerNodeStatus {
  if (selectedStep?.nodeId === nodeId && !terminalSelectionSettled) {
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

function isSettledTerminalSelection(
  bundle: LoadedRunBundle,
  selectedStep: FlowStepRecord | null,
  runOutcome: RunOutcomeView,
  terminalNodeIds: Set<string>,
  playback: PlaybackPreview | null,
): boolean {
  const lastStep = bundle.steps.at(-1) ?? null;
  if (!selectedStep || !lastStep || !runOutcome.isTerminal || playback) {
    return false;
  }
  if (!terminalNodeIds.has(selectedStep.nodeId)) {
    return false;
  }
  if (selectedStep.attemptId !== lastStep.attemptId) {
    return false;
  }
  if (runOutcome.nodeId && runOutcome.nodeId !== selectedStep.nodeId) {
    return false;
  }
  if (runOutcome.attemptId && runOutcome.attemptId !== selectedStep.attemptId) {
    return false;
  }
  return true;
}

function findLatestVisibleAttempt(
  steps: FlowStepRecord[],
  nodeId: string,
): FlowStepRecord | undefined {
  const matching = steps.filter((step) => step.nodeId === nodeId);
  return matching.at(-1);
}

function deriveFallbackNodePosition(
  nodeId: string,
  levelByNode: Map<string, number>,
  rankOrder: Map<number, string[]>,
): { x: number; y: number } {
  const level = levelByNode.get(nodeId) ?? 0;
  const laneNodes = rankOrder.get(level) ?? [];
  const column = laneNodes.indexOf(nodeId);
  const laneWidth = 332;
  return {
    x: (column - (laneNodes.length - 1) / 2) * laneWidth,
    y: level * 236,
  };
}

function estimateElkNodeHeight(branchLabelCount: number): number {
  const branchRows = branchLabelCount > 0 ? Math.ceil(Math.min(branchLabelCount, 4) / 3) : 0;
  return ELK_NODE_BASE_HEIGHT + branchRows * ELK_BRANCH_ROW_HEIGHT;
}

function extractElkEdgePoints(edge: ElkExtendedEdge): ElkPoint[] {
  const points: ElkPoint[] = [];

  for (const section of edge.sections ?? []) {
    if (points.length === 0) {
      points.push(section.startPoint);
    }
    for (const bendPoint of section.bendPoints ?? []) {
      points.push(bendPoint);
    }
    points.push(section.endPoint);
  }

  return dedupeConsecutivePoints(points);
}

function dedupeConsecutivePoints(points: ElkPoint[]): ElkPoint[] {
  const deduped: ElkPoint[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) {
      continue;
    }
    deduped.push(point);
  }
  return deduped;
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
  const forwardEdges = expandedEdges.filter((edge) => !backEdgeIds.has(edge.edgeId));
  const ranks = new Map<number, string[]>();
  const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));

  for (const nodeId of orderedNodeIds) {
    const level = levelByNode.get(nodeId) ?? 0;
    const existing = ranks.get(level) ?? [];
    existing.push(nodeId);
    ranks.set(level, existing);
  }

  const maxLevel = Math.max(...ranks.keys());
  let currentOrder = buildRankOrderIndex(ranks);

  for (let pass = 0; pass < 6; pass += 1) {
    for (let level = 1; level <= maxLevel; level += 1) {
      const nodes = ranks.get(level) ?? [];
      sortRankByNeighborBarycenter(nodes, {
        direction: "down",
        forwardEdges,
        levelByNode,
        currentOrder,
        fallbackOrder: orderIndex,
      });
      currentOrder = buildRankOrderIndex(ranks);
    }

    for (let level = maxLevel - 1; level >= 0; level -= 1) {
      const nodes = ranks.get(level) ?? [];
      sortRankByNeighborBarycenter(nodes, {
        direction: "up",
        forwardEdges,
        levelByNode,
        currentOrder,
        fallbackOrder: orderIndex,
      });
      currentOrder = buildRankOrderIndex(ranks);
    }
  }

  return ranks;
}

function buildRankOrderIndex(ranks: Map<number, string[]>): Map<string, number> {
  const order = new Map<string, number>();
  for (const [, nodes] of ranks) {
    nodes.forEach((nodeId, index) => {
      order.set(nodeId, index);
    });
  }
  return order;
}

function sortRankByNeighborBarycenter(
  nodes: string[],
  options: {
    direction: "down" | "up";
    forwardEdges: ExpandedFlowEdge[];
    levelByNode: Map<string, number>;
    currentOrder: Map<string, number>;
    fallbackOrder: Map<string, number>;
  },
): void {
  nodes.sort((left, right) => {
    const leftScore = computeNeighborBarycenter(left, options);
    const rightScore = computeNeighborBarycenter(right, options);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return (options.fallbackOrder.get(left) ?? 0) - (options.fallbackOrder.get(right) ?? 0);
  });
}

function computeNeighborBarycenter(
  nodeId: string,
  options: {
    direction: "down" | "up";
    forwardEdges: ExpandedFlowEdge[];
    levelByNode: Map<string, number>;
    currentOrder: Map<string, number>;
  },
): number {
  const nodeLevel = options.levelByNode.get(nodeId) ?? 0;
  const neighbors =
    options.direction === "down"
      ? options.forwardEdges
          .filter(
            (edge) =>
              edge.target === nodeId && (options.levelByNode.get(edge.source) ?? 0) < nodeLevel,
          )
          .map((edge) => options.currentOrder.get(edge.source))
      : options.forwardEdges
          .filter(
            (edge) =>
              edge.source === nodeId && (options.levelByNode.get(edge.target) ?? 0) > nodeLevel,
          )
          .map((edge) => options.currentOrder.get(edge.target));

  const orderedNeighbors = neighbors.filter((value): value is number => typeof value === "number");
  if (orderedNeighbors.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  return (
    orderedNeighbors.reduce((sum, value) => sum + value, 0) / Math.max(orderedNeighbors.length, 1)
  );
}
