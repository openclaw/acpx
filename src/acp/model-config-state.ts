export type SessionModelState = {
  configId?: string;
  currentModelId: string;
  availableModels: Array<{
    modelId: string;
    name: string;
  }>;
};

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
