import { ZodError, z } from "zod";
import { PERMISSION_MODES } from "../types.js";
import type {
  AcpNodeDefinition,
  ActionNodeDefinition,
  CheckpointNodeDefinition,
  ComputeNodeDefinition,
  FlowDefinition,
  FlowRunDefinition,
  FunctionActionNodeDefinition,
  ShellActionNodeDefinition,
} from "./types.js";

const FLOW_NODE_TYPES = ["acp", "compute", "action", "checkpoint"] as const;

const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const nonEmptyTrimmedStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be empty",
});

function extensibleObject<TShape extends z.ZodRawShape>(shape: TShape) {
  return z.object(shape).passthrough();
}

function functionSchema<T extends Function>(label: string): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === "function", {
    message: `${label} must be a function`,
  });
}

const flowNodeCommonShape = {
  timeoutMs: finiteNonNegativeNumberSchema.optional(),
  heartbeatMs: finiteNonNegativeNumberSchema.optional(),
  statusDetail: z.string().optional(),
} satisfies z.ZodRawShape;

const flowPermissionRequirementsSchema = extensibleObject({
  requiredMode: z.enum(PERMISSION_MODES),
  requireExplicitGrant: z.boolean().optional(),
  reason: nonEmptyTrimmedStringSchema.optional(),
});

const flowRunDefinitionSchema = extensibleObject({
  title: z
    .union([
      z.string(),
      functionSchema<Exclude<FlowRunDefinition["title"], string | undefined>>("run.title"),
    ])
    .optional(),
});

const acpSessionSchema = extensibleObject({
  handle: z.string().optional(),
  isolated: z.boolean().optional(),
});

const acpNodeSchema = extensibleObject({
  ...flowNodeCommonShape,
  nodeType: z.literal("acp"),
  profile: z.string().optional(),
  cwd: z
    .union([
      z.string(),
      functionSchema<Exclude<AcpNodeDefinition["cwd"], string | undefined>>("cwd"),
    ])
    .optional(),
  session: acpSessionSchema.optional(),
  prompt: functionSchema<AcpNodeDefinition["prompt"]>("prompt"),
  parse: functionSchema<NonNullable<AcpNodeDefinition["parse"]>>("parse").optional(),
});

const computeNodeSchema = extensibleObject({
  ...flowNodeCommonShape,
  nodeType: z.literal("compute"),
  run: functionSchema<ComputeNodeDefinition["run"]>("run"),
});

const functionActionNodeSchema = extensibleObject({
  ...flowNodeCommonShape,
  nodeType: z.literal("action"),
  run: functionSchema<FunctionActionNodeDefinition["run"]>("run"),
});

const shellActionNodeSchema = extensibleObject({
  ...flowNodeCommonShape,
  nodeType: z.literal("action"),
  exec: functionSchema<ShellActionNodeDefinition["exec"]>("exec"),
  parse: functionSchema<NonNullable<ShellActionNodeDefinition["parse"]>>("parse").optional(),
}).refine((node) => !hasOwn(node, "run"), {
  message: "shell action nodes must not define run",
});

const checkpointNodeSchema = extensibleObject({
  ...flowNodeCommonShape,
  nodeType: z.literal("checkpoint"),
  summary: z.string().optional(),
  run: functionSchema<NonNullable<CheckpointNodeDefinition["run"]>>("run").optional(),
});

const directFlowEdgeSchema = extensibleObject({
  from: z.string(),
  to: z.string(),
}).refine((edge) => !hasOwn(edge, "switch"), {
  message: 'direct flow edges must not define "switch"',
});

const switchFlowEdgeSchema = extensibleObject({
  from: z.string(),
  switch: extensibleObject({
    on: z.string(),
    cases: z.record(z.string(), z.string()),
  }),
}).refine((edge) => !hasOwn(edge, "to"), {
  message: 'switch flow edges must not define "to"',
});

const flowEdgeSchema = z.union([directFlowEdgeSchema, switchFlowEdgeSchema]);

const flowDefinitionSchema = extensibleObject({
  name: nonEmptyTrimmedStringSchema,
  run: flowRunDefinitionSchema.optional(),
  permissions: flowPermissionRequirementsSchema.optional(),
  startAt: z.string(),
  nodes: z.record(z.string(), z.unknown()),
  edges: z.array(flowEdgeSchema),
});

const flowNodeTypeSchema = z.object({
  nodeType: z.enum(FLOW_NODE_TYPES),
});

export function assertValidFlowDefinitionShape(flow: FlowDefinition): void {
  const parsed = parseWithSchema("flow definition", flowDefinitionSchema, flow);

  for (const [nodeId, node] of Object.entries(parsed.nodes)) {
    assertValidFlowNodeDefinitionShape(node, `flow node "${nodeId}"`);
  }
}

export function assertValidAcpNodeDefinition(node: AcpNodeDefinition): void {
  parseWithSchema("acp node definition", acpNodeSchema, node);
}

export function assertValidComputeNodeDefinition(node: ComputeNodeDefinition): void {
  parseWithSchema("compute node definition", computeNodeSchema, node);
}

export function assertValidActionNodeDefinition(node: ActionNodeDefinition): void {
  assertValidActionNodeDefinitionShape(node, "action node definition");
}

export function assertValidShellActionNodeDefinition(node: ShellActionNodeDefinition): void {
  parseWithSchema("shell action node definition", shellActionNodeSchema, node);
}

export function assertValidCheckpointNodeDefinition(node: CheckpointNodeDefinition): void {
  parseWithSchema("checkpoint node definition", checkpointNodeSchema, node);
}

function assertValidFlowNodeDefinitionShape(node: unknown, label: string): void {
  const { nodeType } = parseWithSchema(label, flowNodeTypeSchema, node);

  switch (nodeType) {
    case "acp":
      parseWithSchema(label, acpNodeSchema, node);
      return;
    case "compute":
      parseWithSchema(label, computeNodeSchema, node);
      return;
    case "action":
      assertValidActionNodeDefinitionShape(node, label);
      return;
    case "checkpoint":
      parseWithSchema(label, checkpointNodeSchema, node);
      return;
  }
}

function assertValidActionNodeDefinitionShape(node: unknown, label: string): void {
  const hasRun = hasOwn(node, "run");
  const hasExec = hasOwn(node, "exec");

  if (hasRun === hasExec) {
    throw new Error(`Invalid ${label}: action nodes must define exactly one of run or exec`);
  }

  if (hasExec) {
    parseWithSchema(label, shellActionNodeSchema, node);
    return;
  }

  parseWithSchema(label, functionActionNodeSchema, node);
}

function parseWithSchema<T>(label: string, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(formatValidationError(label, error), { cause: error });
    }
    throw error;
  }
}

function formatValidationError(label: string, error: ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return `Invalid ${label}: ${details}`;
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    value != null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
  );
}
