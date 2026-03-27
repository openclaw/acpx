import { Position, type Edge, type Node } from "@xyflow/react";
import type {
  FlowDefinitionSnapshot,
  FlowNodeOutcome,
  FlowStepRecord,
  LoadedRunBundle,
} from "../types";
import { formatDuration, humanizeIdentifier } from "./view-model-format.js";
import type {
  PlaybackPreview,
  RunOutcomeView,
  ViewerNodeData,
  ViewerNodeStatus,
} from "./view-model-types";

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
