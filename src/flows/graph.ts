import { assertValidFlowDefinitionShape } from "./schema.js";
import type { FlowDefinition, FlowEdge, FlowNodeResult } from "./types.js";

export function validateFlowDefinition(flow: FlowDefinition): void {
  assertValidFlowDefinitionShape(flow);
  if (!flow.nodes[flow.startAt]) {
    throw new Error(`Flow start node is missing: ${flow.startAt}`);
  }

  const outgoingEdges = new Set<string>();
  for (const edge of flow.edges) {
    validateFlowEdge(flow, edge, outgoingEdges);
  }
}

function assertKnownFlowNode(flow: FlowDefinition, nodeId: string, description: string): void {
  if (!flow.nodes[nodeId]) {
    throw new Error(`${description}: ${nodeId}`);
  }
}

function validateFlowEdge(flow: FlowDefinition, edge: FlowEdge, outgoingEdges: Set<string>): void {
  assertKnownFlowNode(flow, edge.from, "Flow edge references unknown from-node");
  if (outgoingEdges.has(edge.from)) {
    throw new Error(`Flow node must not declare multiple outgoing edges: ${edge.from}`);
  }
  outgoingEdges.add(edge.from);

  if ("to" in edge) {
    assertKnownFlowNode(flow, edge.to, "Flow edge references unknown to-node");
    return;
  }

  for (const target of Object.values(edge.switch.cases)) {
    assertKnownFlowNode(flow, target, "Flow switch references unknown to-node");
  }
}

export function resolveNext(
  edges: FlowEdge[],
  from: string,
  output: unknown,
  result?: FlowNodeResult,
): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge) {
    return null;
  }

  if ("to" in edge) {
    return edge.to;
  }

  const value = getBySwitchPath(output, result, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
}

export function resolveNextForOutcome(
  edges: FlowEdge[],
  from: string,
  result: FlowNodeResult,
): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge || "to" in edge) {
    return null;
  }
  if (!edge.switch.on.startsWith("$result.")) {
    return null;
  }
  const value = getBySwitchPath(undefined, result, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
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
