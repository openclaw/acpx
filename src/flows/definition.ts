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
  return definition;
}

export function acp(definition: Omit<AcpNodeDefinition, "nodeType">): AcpNodeDefinition {
  return {
    nodeType: "acp",
    ...definition,
  };
}

export function compute(
  definition: Omit<ComputeNodeDefinition, "nodeType">,
): ComputeNodeDefinition {
  return {
    nodeType: "compute",
    ...definition,
  };
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
  return {
    nodeType: "action",
    ...definition,
  } as ActionNodeDefinition;
}

export function shell(
  definition: Omit<ShellActionNodeDefinition, "nodeType">,
): ShellActionNodeDefinition {
  return {
    nodeType: "action",
    ...definition,
  };
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "nodeType"> = {},
): CheckpointNodeDefinition {
  return {
    nodeType: "checkpoint",
    ...definition,
  };
}
