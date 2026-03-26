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

export function acp(definition: Omit<AcpNodeDefinition, "kind">): AcpNodeDefinition {
  return {
    kind: "acp",
    ...definition,
  };
}

export function compute(definition: Omit<ComputeNodeDefinition, "kind">): ComputeNodeDefinition {
  return {
    kind: "compute",
    ...definition,
  };
}

export function action(
  definition: Omit<FunctionActionNodeDefinition, "kind">,
): FunctionActionNodeDefinition;
export function action(
  definition: Omit<ShellActionNodeDefinition, "kind">,
): ShellActionNodeDefinition;
export function action(
  definition: Omit<FunctionActionNodeDefinition, "kind"> | Omit<ShellActionNodeDefinition, "kind">,
): ActionNodeDefinition {
  return {
    kind: "action",
    ...definition,
  } as ActionNodeDefinition;
}

export function shell(
  definition: Omit<ShellActionNodeDefinition, "kind">,
): ShellActionNodeDefinition {
  return {
    kind: "action",
    ...definition,
  };
}

export function checkpoint(
  definition: Omit<CheckpointNodeDefinition, "kind"> = {},
): CheckpointNodeDefinition {
  return {
    kind: "checkpoint",
    ...definition,
  };
}
