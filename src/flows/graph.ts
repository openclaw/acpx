import { assertValidFlowDefinitionShape } from "./schema.js";
import type { FlowDefinition, FlowEdge, FlowNodeResult } from "./types.js";

export function validateFlowDefinition(flow: FlowDefinition): void {
  assertValidFlowDefinitionShape(flow);
  assertKnownFlowNode(flow, flow.startAt, "Flow start node is missing");

  const outgoingEdges = new Set<string>();
  for (const edge of flow.edges) {
    validateFlowEdge(flow, edge, outgoingEdges);
  }
}

function assertKnownFlowNode(flow: FlowDefinition, nodeId: string, description: string): void {
  if (!Object.hasOwn(flow.nodes, nodeId)) {
    throw new Error(`${description}: ${nodeId}`);
  }
}

function isDirectEdge(edge: FlowEdge): edge is Extract<FlowEdge, { to: string }> {
  return Object.hasOwn(edge, "to");
}

function validateFlowEdge(flow: FlowDefinition, edge: FlowEdge, outgoingEdges: Set<string>): void {
  assertKnownFlowNode(flow, edge.from, "Flow edge references unknown from-node");
  if (outgoingEdges.has(edge.from)) {
    throw new Error(`Flow node must not declare multiple outgoing edges: ${edge.from}`);
  }
  outgoingEdges.add(edge.from);

  if (isDirectEdge(edge)) {
    assertKnownFlowNode(flow, edge.to, "Flow edge references unknown to-node");
    return;
  }

  for (const target of Object.values(edge.switch.cases)) {
    assertKnownFlowNode(flow, target, "Flow switch references unknown to-node");
  }
}

function canFollowEdge(edge: FlowEdge, result: FlowNodeResult | undefined): boolean {
  return (
    !result ||
    result.outcome === "ok" ||
    (!isDirectEdge(edge) && edge.switch.on.startsWith("$result."))
  );
}

export function resolveNext(
  edges: FlowEdge[],
  from: string,
  output: unknown,
  result?: FlowNodeResult,
): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge || !canFollowEdge(edge, result)) {
    return null;
  }

  if (isDirectEdge(edge)) {
    return edge.to;
  }

  const value = getBySwitchPath(output, result, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const key = String(value);
  if (!Object.hasOwn(edge.switch.cases, key)) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return edge.switch.cases[key];
}

function getBySwitchPath(
  output: unknown,
  result: FlowNodeResult | undefined,
  jsonPath: string,
): unknown {
  if (jsonPath.startsWith("$result.")) {
    return getByPath(result, `$.${jsonPath.slice("$result.".length)}`);
  }
  if (jsonPath.startsWith("$output.")) {
    return getByPath(output, `$.${jsonPath.slice("$output.".length)}`);
  }
  return getByPath(output, jsonPath);
}

function getByPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new Error(`Unsupported JSON path: ${jsonPath}`);
  }

  return jsonPath
    .slice(2)
    .split(".")
    .reduce((current: unknown, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}
