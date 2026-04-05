import { markDefinedFlow } from "./authoring.js";
import {
  assertValidAcpNodeDefinition,
  assertValidActionNodeDefinition,
  assertValidCheckpointNodeDefinition,
  assertValidComputeNodeDefinition,
  assertValidFlowDefinitionShape,
  assertValidShellActionNodeDefinition,
} from "./schema.js";
import type {
  AcpNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FlowDefinition,
  FunctionActionNodeDefinition,
  ShellActionNodeDefinition,
} from "./types.js";

export function defineFlow<TFlow extends FlowDefinition>(definition: TFlow): TFlow {
  assertValidFlowDefinitionShape(definition);
  return markDefinedFlow(definition);
}

export function acp(definition: Omit<AcpNodeDefinition, "nodeType">): AcpNodeDefinition {
  const node: AcpNodeDefinition = {
    nodeType: "acp",
    ...definition,
  };
  assertValidAcpNodeDefinition(node);
  return node;
}

export function compute(
  definition: Omit<ComputeNodeDefinition, "nodeType">,
): ComputeNodeDefinition {
  const node: ComputeNodeDefinition = {
    nodeType: "compute",
    ...definition,
  };
  assertValidComputeNodeDefinition(node);
  return node;
}

export function action(
  definition: Omit<FunctionActionNodeDefinition, "nodeType">,
): FunctionActionNodeDefinition;
export function action(
  definition: Omit<ShellActionNodeDefinition, "nodeType">,
): ShellActionNodeDefinition;
export function action(
  definition:
    | Omit<FunctionActionNodeDefinition, "nodeType">
    | Omit<ShellActionNodeDefinition, "nodeType">,
): ActionNodeDefinition {
  const node: ActionNodeDefinition = {
    nodeType: "action",
    ...definition,
  } as ActionNodeDefinition;
  assertValidActionNodeDefinition(node);
  return node;
}

export function shell(
  definition: Omit<ShellActionNodeDefinition, "nodeType">,
): ShellActionNodeDefinition {
  const node: ShellActionNodeDefinition = {
    nodeType: "action",
    ...definition,
  };
  assertValidShellActionNodeDefinition(node);
  return node;
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "nodeType"> = {},
): CheckpointNodeDefinition {
  const node: CheckpointNodeDefinition = {
    nodeType: "checkpoint",
    ...definition,
  };
  assertValidCheckpointNodeDefinition(node);
  return node;
}
