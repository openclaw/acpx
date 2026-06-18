import { modelStateFromConfigOptions, type SessionModelState } from "../acp/model-support.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { applyAdvertisedModelState } from "./model-state.js";

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

export function normalizeModeId(modeId: string | undefined): string | undefined {
  if (typeof modeId !== "string") {
    return undefined;
  }
  const trimmed = modeId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const trimmed = modelId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDesiredModeId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModeId(state?.desired_mode_id);
}

export function getDesiredConfigOptions(
  state: SessionAcpxState | undefined,
): Record<string, string> {
  const desired = state?.desired_config_options;
  if (!desired) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(desired).flatMap(([configId, value]) => {
      const normalizedConfigId = normalizeModeId(configId);
      return normalizedConfigId && typeof value === "string" ? [[normalizedConfigId, value]] : [];
    }),
  );
}

export function setDesiredModeId(record: SessionRecord, modeId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModeId(modeId);

  if (normalized) {
    acpx.desired_mode_id = normalized;
  } else {
    delete acpx.desired_mode_id;
  }

  record.acpx = acpx;
}

export function setDesiredConfigOption(
  record: SessionRecord,
  configId: string,
  value: string | undefined,
): void {
  const normalizedConfigId = normalizeModeId(configId);
  if (!normalizedConfigId || normalizedConfigId === "mode" || normalizedConfigId === "model") {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  const desired = { ...acpx.desired_config_options };

  if (typeof value === "string") {
    desired[normalizedConfigId] = value;
  } else {
    delete desired[normalizedConfigId];
  }

  if (Object.keys(desired).length > 0) {
    acpx.desired_config_options = desired;
  } else {
    delete acpx.desired_config_options;
  }

  record.acpx = acpx;
}

export function clearDesiredConfigOption(
  state: SessionAcpxState,
  configId: string | undefined,
): void {
  const normalizedConfigId = normalizeModeId(configId);
  if (!normalizedConfigId || !state.desired_config_options) {
    return;
  }
  const desired = { ...state.desired_config_options };
  delete desired[normalizedConfigId];
  if (Object.keys(desired).length > 0) {
    state.desired_config_options = desired;
  } else {
    delete state.desired_config_options;
  }
}

export function getDesiredModelId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModelId(state?.session_options?.model);
}

function hasStoredSessionOptions(
  options: NonNullable<SessionAcpxState["session_options"]>,
): boolean {
  return (
    typeof options.model === "string" ||
    Array.isArray(options.allowed_tools) ||
    typeof options.max_turns === "number" ||
    options.system_prompt !== undefined ||
    options.env !== undefined
  );
}

export function setDesiredModelId(
  record: SessionRecord,
  modelId: string | undefined,
  modelConfigId?: string,
): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.model = normalized;
  } else {
    delete sessionOptions.model;
  }

  if (hasStoredSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }

  clearDesiredConfigOption(
    acpx,
    modelConfigId ?? modelStateFromConfigOptions(acpx.config_options)?.configId,
  );
  record.acpx = acpx;
}

export function setCurrentModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);

  if (normalized) {
    acpx.current_model_id = normalized;
  } else {
    delete acpx.current_model_id;
  }

  record.acpx = acpx;
}

export function syncAdvertisedModelState(
  record: SessionRecord,
  models: SessionModelState | undefined,
): void {
  if (!models) {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  applyAdvertisedModelState(acpx, models);
  record.acpx = acpx;
}
