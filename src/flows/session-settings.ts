import type { SessionConfiguration } from "../session/configuration.js";
import type { AcpNodeDefinition, FlowSessionBinding } from "./types.js";

export function assertCompatibleSessionSettings(
  node: AcpNodeDefinition,
  binding: FlowSessionBinding,
): void {
  const pinned = binding.requestedSettings ?? { configOptions: [] };
  if (node.model !== undefined && node.model.trim() !== normalizedModel(pinned.model)) {
    throw new Error(`Conflicting model for persistent session handle "${binding.handle}"`);
  }
  const pinnedOptions = finalSelections(pinned.configOptions);
  for (const [configId, value] of finalSelections(node.configOptions ?? [])) {
    if (pinnedOptions.get(configId) !== value) {
      throw new Error(
        `Conflicting config option "${configId}" for persistent session handle "${binding.handle}"`,
      );
    }
  }
}

function normalizedModel(model: string | undefined): string | undefined {
  return model?.trim();
}

function finalSelections(
  selections: Array<{ configId: string; value: string }>,
): Map<string, string> {
  return new Map(selections.map(({ configId, value }) => [configId, value]));
}

export function assertReplayedSessionSettings(
  binding: FlowSessionBinding,
  configuration: SessionConfiguration,
): void {
  const accepted = binding.acceptedSettings ?? { configOptions: [] };
  if (!replayedModelMatches(accepted.model, configuration.model)) {
    throw new Error(`Cannot replay pinned model for persistent session handle "${binding.handle}"`);
  }
  const expected = new Map(
    accepted.configOptions.map(({ configId, acceptedValue }) => [configId, acceptedValue]),
  );
  for (const [configId, acceptedValue] of new Map(
    configuration.configOptions.map((selection) => [selection.configId, selection.acceptedValue]),
  )) {
    if (expected.get(configId) !== acceptedValue) {
      throw new Error(
        `Cannot replay pinned config option "${configId}" for persistent session handle "${binding.handle}"`,
      );
    }
  }
}

function replayedModelMatches(
  expected: SessionConfiguration["model"],
  actual: SessionConfiguration["model"],
): boolean {
  if (!expected?.applied) {
    return true;
  }
  return actual?.applied === true && actual.accepted === expected.accepted;
}
