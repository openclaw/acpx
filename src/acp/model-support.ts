import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";

export type SessionModelState = {
  configId?: string;
  currentModelId: string;
  availableModels: Array<{
    modelId: string;
    name: string;
  }>;
};

type LegacySessionModelResponse = {
  models?: {
    currentModelId?: unknown;
    availableModels?: unknown;
  } | null;
};

export class RequestedModelUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestedModelUnsupportedError";
  }
}

export function supportsLegacyClaudeCodeModelMetadata(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
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

function parseModelConfigOption(value: unknown): SessionModelState | undefined {
  const option = asRecord(value);
  if (
    !option ||
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

export function modelStateFromConfigOptions(configOptions: unknown): SessionModelState | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }

  for (const value of configOptions) {
    const models = parseModelConfigOption(value);
    if (models) {
      return models;
    }
  }
  return undefined;
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

export function assertRequestedModelSupported(params: {
  requestedModel: string;
  models: SessionModelState | undefined;
  agentCommand?: string;
  context: "apply" | "replay";
}): string | undefined {
  if (!params.models) {
    if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) {
      return undefined;
    }
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise model support through a session config option or legacy models metadata, and the adapter does not support a startup model flag.`,
    );
  }

  const advertised = new Set(params.models.availableModels.map((model) => model.modelId));
  if (!advertised.has(params.requestedModel)) {
    if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) {
      return `requested model "${params.requestedModel}" was not in the Claude ACP advertised model list (${formatAvailableModelIds(params.models)}); forwarding it to Claude Code so the adapter can accept or reject it.`;
    }
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`,
    );
  }
  return undefined;
}
