import type { FlowDefinition, FlowEdge } from "./types.js";

export function validateFlowDefinition(flow: FlowDefinition): void {
  if (!flow.name.trim()) {
    throw new Error("Flow name must not be empty");
  }
  if (!flow.nodes[flow.startAt]) {
    throw new Error(`Flow start node is missing: ${flow.startAt}`);
  }

  const outgoingEdges = new Set<string>();
  for (const edge of flow.edges) {
    if (!flow.nodes[edge.from]) {
      throw new Error(`Flow edge references unknown from-node: ${edge.from}`);
    }
    if (outgoingEdges.has(edge.from)) {
      throw new Error(`Flow node must not declare multiple outgoing edges: ${edge.from}`);
    }
    outgoingEdges.add(edge.from);
    if ("to" in edge) {
      if (!flow.nodes[edge.to]) {
        throw new Error(`Flow edge references unknown to-node: ${edge.to}`);
      }
      continue;
    }
    for (const target of Object.values(edge.switch.cases)) {
      if (!flow.nodes[target]) {
        throw new Error(`Flow switch references unknown to-node: ${target}`);
      }
    }
  }
}

export function resolveNext(edges: FlowEdge[], from: string, output: unknown): string | null {
  const edge = edges.find((candidate) => candidate.from === from);
  if (!edge) {
    return null;
  }

  if ("to" in edge) {
    return edge.to;
  }

  const value = getByPath(output, edge.switch.on);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Flow switch value must be scalar for ${edge.switch.on}`);
  }
  const next = edge.switch.cases[String(value)];
  if (!next) {
    throw new Error(`No flow switch case for ${edge.switch.on}=${JSON.stringify(value)}`);
  }
  return next;
}

function getByPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new Error(`Unsupported JSON path: ${jsonPath}`);
  }

  return jsonPath
    .slice(2)
    .split(".")
    .reduce<unknown>((current, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}
