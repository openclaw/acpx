import type { SessionRecord, SessionTokenUsage } from "../../types.js";
import type {
  AcpRuntimeAvailableCommand,
  AcpRuntimeSessionModels,
  AcpRuntimeSessionUsage,
  AcpRuntimeStatus,
  AcpRuntimeUsageBreakdown,
} from "../public/contract.js";
import { asOptionalString } from "../public/shared.js";

export function runtimeStatusFromRecord(record: SessionRecord): AcpRuntimeStatus {
  return {
    summary: statusSummary(record),
    acpxRecordId: record.acpxRecordId,
    backendSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
    ...buildModelsField(record),
    ...buildUsageField(record),
    ...buildAvailableCommandsField(record),
    details: {
      cwd: record.cwd,
      lastUsedAt: record.lastUsedAt,
      closed: record.closed === true,
      ...(record.acpx?.config_options !== undefined
        ? { configOptions: structuredClone(record.acpx.config_options) }
        : {}),
    },
  };
}

function statusSummary(record: SessionRecord): string {
  const parts = [
    `session=${record.acpxRecordId}`,
    `backendSessionId=${record.acpSessionId}`,
    record.agentSessionId ? `agentSessionId=${record.agentSessionId}` : null,
    record.pid != null ? `pid=${record.pid}` : null,
    record.closed ? "closed" : "open",
  ].filter(Boolean);
  return parts.join(" ");
}

function buildModelsField(record: SessionRecord): { models?: AcpRuntimeSessionModels } {
  const available = record.acpx?.available_models;
  const currentModelId = record.acpx?.current_model_id;
  if (!available || available.length === 0) {
    return currentModelId === undefined
      ? {}
      : { models: { currentModelId, availableModelIds: [] } };
  }
  return {
    models: {
      ...(currentModelId !== undefined ? { currentModelId } : {}),
      availableModelIds: [...available],
    },
  };
}

function tokenUsageToBreakdown(
  usage: SessionTokenUsage | undefined,
): AcpRuntimeUsageBreakdown | undefined {
  if (!usage) {
    return undefined;
  }
  const breakdown: AcpRuntimeUsageBreakdown = {};
  assignUsageBreakdownField(breakdown, "inputTokens", usage.input_tokens);
  assignUsageBreakdownField(breakdown, "outputTokens", usage.output_tokens);
  assignUsageBreakdownField(breakdown, "cachedReadTokens", usage.cache_read_input_tokens);
  assignUsageBreakdownField(breakdown, "cachedWriteTokens", usage.cache_creation_input_tokens);
  assignUsageBreakdownField(breakdown, "thoughtTokens", usage.thought_tokens);
  assignUsageBreakdownField(breakdown, "totalTokens", usage.total_tokens);
  return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function assignUsageBreakdownField(
  breakdown: AcpRuntimeUsageBreakdown,
  key: keyof AcpRuntimeUsageBreakdown,
  value: number | undefined,
): void {
  if (value !== undefined) {
    breakdown[key] = value;
  }
}

function buildUsageField(record: SessionRecord): { usage?: AcpRuntimeSessionUsage } {
  const cumulative = tokenUsageToBreakdown(record.cumulative_token_usage);
  const perRequestEntries = Object.entries(record.request_token_usage ?? {})
    .map(([id, value]) => [id, tokenUsageToBreakdown(value)] as const)
    .filter(
      (entry): entry is readonly [string, AcpRuntimeUsageBreakdown] => entry[1] !== undefined,
    );
  const perRequest =
    perRequestEntries.length > 0 ? Object.fromEntries(perRequestEntries) : undefined;
  const cost = record.cumulative_cost;
  const usage: AcpRuntimeSessionUsage = {
    ...(cumulative ? { cumulative } : {}),
    ...(cost ? { cost } : {}),
    ...(perRequest ? { perRequest } : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : {};
}

function buildAvailableCommandsField(record: SessionRecord): {
  availableCommands?: AcpRuntimeAvailableCommand[];
} {
  const commands = record.acpx?.available_commands as readonly unknown[] | undefined;
  if (!commands || commands.length === 0) {
    return {};
  }
  const availableCommands = commands
    .map((command) => runtimeAvailableCommand(command))
    .filter((command): command is AcpRuntimeAvailableCommand => command !== undefined);
  return availableCommands.length > 0 ? { availableCommands } : {};
}

function runtimeAvailableCommand(command: unknown): AcpRuntimeAvailableCommand | undefined {
  if (typeof command === "string") {
    const name = command.trim();
    return name ? { name } : undefined;
  }
  const record = commandRecord(command);
  if (!record) {
    return undefined;
  }
  const name = asOptionalString(record.name);
  if (!name) {
    return undefined;
  }
  const runtimeCommand: AcpRuntimeAvailableCommand = { name };
  const description = asOptionalString(record.description);
  if (description) {
    runtimeCommand.description = description;
  }
  if (typeof record.has_input === "boolean") {
    runtimeCommand.hasInput = record.has_input;
  }
  return runtimeCommand;
}

function commandRecord(
  value: unknown,
): { name?: unknown; description?: unknown; has_input?: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}
