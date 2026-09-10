import { isClaudeAcpCommand, isCursorAcpCommand, isDevinAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";

export type SessionModelState = {
  configId?: string;
  currentModelId: string;
  availableModels: Array<{
    modelId: string;
    name: string;
  }>;
};

type AdvertisedModelIds = Pick<SessionModelState, "availableModels">;

type LegacySessionModelResponse = {
  models?: {
    currentModelId?: unknown;
    availableModels?: unknown;
  } | null;
};

export const REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE = "ACP_MODEL_UNSUPPORTED" as const;

export type RequestedModelUnsupportedErrorCode = typeof REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;

export const REQUESTED_MODEL_UNSUPPORTED_REASONS = [
  "missing-capability",
  "unadvertised-model",
] as const;

export type RequestedModelUnsupportedReason = (typeof REQUESTED_MODEL_UNSUPPORTED_REASONS)[number];

export class RequestedModelUnsupportedError extends Error {
  readonly code = REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;
  readonly reason: RequestedModelUnsupportedReason;

  constructor(message: string, reason: RequestedModelUnsupportedReason) {
    super(message);
    this.name = "RequestedModelUnsupportedError";
    this.reason = reason;
  }
}

function isRequestedModelUnsupportedReason(
  value: unknown,
): value is RequestedModelUnsupportedReason {
  return (
    typeof value === "string" &&
    REQUESTED_MODEL_UNSUPPORTED_REASONS.includes(value as RequestedModelUnsupportedReason)
  );
}

export function isRequestedModelUnsupportedError(
  value: unknown,
): value is RequestedModelUnsupportedError {
  if (value instanceof RequestedModelUnsupportedError) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { code?: unknown; name?: unknown; reason?: unknown };
  return (
    candidate.name === "RequestedModelUnsupportedError" &&
    candidate.code === REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE &&
    isRequestedModelUnsupportedReason(candidate.reason)
  );
}

export function supportsLegacyClaudeCodeModelMetadata(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
}

export function supportsStartupModelFlag(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isDevinAcpCommand(command, args);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

type AvailableModel = SessionModelState["availableModels"][number];

function parseAvailableModel(value: unknown): AvailableModel | undefined {
  const option = asRecord(value);
  if (!option || typeof option.value !== "string" || typeof option.name !== "string") {
    return undefined;
  }
  return { modelId: option.value, name: option.name };
}

function parseAvailableModelGroup(value: unknown): AvailableModel[] | undefined {
  const group = asRecord(value);
  if (
    !group ||
    typeof group.group !== "string" ||
    typeof group.name !== "string" ||
    !Array.isArray(group.options)
  ) {
    return undefined;
  }
  const models = group.options.map((option) => parseAvailableModel(option));
  return models.every((model): model is AvailableModel => model !== undefined) ? models : undefined;
}

function parseAvailableModels(value: unknown): AvailableModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const directModels = value.map((option) => parseAvailableModel(option));
  if (directModels.every((model): model is AvailableModel => model !== undefined)) {
    return directModels;
  }
  const groupedModels = value.map((group) => parseAvailableModelGroup(group));
  return groupedModels.every((models): models is AvailableModel[] => models !== undefined)
    ? groupedModels.flat()
    : undefined;
}

function isModelSelectOption(option: Record<string, unknown>): boolean {
  return option.type === "select" && (option.category === "model" || option.id === "model");
}

function parseModelConfigOption(option: Record<string, unknown>): SessionModelState | undefined {
  if (
    !isModelSelectOption(option) ||
    typeof option.id !== "string" ||
    typeof option.currentValue !== "string"
  ) {
    return undefined;
  }
  const availableModels = parseAvailableModels(option.options);
  return availableModels
    ? {
        configId: option.id,
        currentModelId: option.currentValue,
        availableModels,
      }
    : undefined;
}

function modelConfigPriority(option: Record<string, unknown>): number {
  if (option.category !== "model") {
    return 0;
  }
  return option.id === "model" ? 2 : 1;
}

export function modelStateFromConfigOptions(configOptions: unknown): SessionModelState | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }

  let selected: SessionModelState | undefined;
  let selectedPriority = -1;
  for (const value of configOptions) {
    const option = asRecord(value);
    if (!option) {
      continue;
    }
    const models = parseModelConfigOption(option);
    if (!models) {
      continue;
    }
    const priority = modelConfigPriority(option);
    if (priority > selectedPriority) {
      selected = models;
      selectedPriority = priority;
    }
  }
  return selected;
}

export function modelStateFromLegacyResponse(response: unknown): SessionModelState | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const models = (response as LegacySessionModelResponse).models;
  if (
    !models ||
    typeof models.currentModelId !== "string" ||
    !Array.isArray(models.availableModels)
  ) {
    return undefined;
  }

  const availableModels = models.availableModels.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as { modelId?: unknown; name?: unknown };
    return typeof candidate.modelId === "string" && typeof candidate.name === "string"
      ? [{ modelId: candidate.modelId, name: candidate.name }]
      : [];
  });
  return {
    currentModelId: models.currentModelId,
    availableModels,
  };
}

export function modelStateFromSessionResponse(params: {
  configOptions: unknown;
  response: unknown;
}): SessionModelState | undefined {
  return (
    modelStateFromConfigOptions(params.configOptions) ??
    modelStateFromLegacyResponse(params.response)
  );
}

export function formatAvailableModelIds(models: SessionModelState | undefined): string {
  const ids =
    models?.availableModels
      .map((model) => model.modelId.trim())
      .filter((modelId) => modelId.length > 0) ?? [];
  return ids.length > 0 ? ids.join(", ") : "none advertised";
}

export function resolveRequestedModelId(params: {
  requestedModel: string;
  models: AdvertisedModelIds | undefined;
  agentCommand?: string;
}): string {
  if (!params.models || !isCursorAcpCommandForModelAlias(params.agentCommand)) {
    return params.requestedModel;
  }

  if (params.models.availableModels.some((model) => model.modelId === params.requestedModel)) {
    return params.requestedModel;
  }

  const candidates = params.models.availableModels
    .map((model) => model.modelId)
    .filter((modelId) => modelId.startsWith(`${params.requestedModel}[`));
  return candidates.length === 1 ? candidates[0] : params.requestedModel;
}

function isCursorAcpCommandForModelAlias(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isCursorAcpCommand(command, args);
}

function assertModelCapableWithoutAdvertisedModels(params: {
  requestedModel: string;
  agentCommand?: string;
  context: "apply" | "replay";
}): void {
  if (
    supportsLegacyClaudeCodeModelMetadata(params.agentCommand) ||
    supportsStartupModelFlag(params.agentCommand)
  ) {
    return;
  }
  const action = params.context === "replay" ? "replay saved model" : "apply --model";
  throw new RequestedModelUnsupportedError(
    `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise model support through a session config option or legacy models metadata, and the adapter does not support a startup model flag.`,
    "missing-capability",
  );
}

export function assertRequestedModelSupported(params: {
  requestedModel: string;
  models: SessionModelState | undefined;
  agentCommand?: string;
  context: "apply" | "replay";
  appliedViaStartupFlag?: boolean;
}): string | undefined {
  if (!params.models) {
    assertModelCapableWithoutAdvertisedModels(params);
    return undefined;
  }

  const advertised = new Set(params.models.availableModels.map((model) => model.modelId));
  if (!advertised.has(params.requestedModel)) {
    const resolvedModel = resolveRequestedModelId(params);
    if (resolvedModel !== params.requestedModel) {
      return `Cursor ACP advertised "${resolvedModel}" for requested model "${params.requestedModel}"; using the advertised id.`;
    }
    if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) {
      return `requested model "${params.requestedModel}" was not in the Claude ACP advertised model list (${formatAvailableModelIds(params.models)}); forwarding it to Claude Code so the adapter can accept or reject it.`;
    }
    if (supportsStartupModelFlag(params.agentCommand)) {
      if (params.appliedViaStartupFlag) {
        return `requested model "${params.requestedModel}" was not in the advertised model list (${formatAvailableModelIds(params.models)}); it was passed to the agent as a startup flag for the adapter to accept or reject.`;
      }
      return `requested model "${params.requestedModel}" was not in the advertised model list (${formatAvailableModelIds(params.models)}); forwarding it to the adapter so it can accept or reject it.`;
    }
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`,
      "unadvertised-model",
    );
  }
  return undefined;
}
