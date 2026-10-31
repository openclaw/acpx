import type { SessionModelState } from "../acp/model-support.js";
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
    Object.entries(desired).filter(([, value]) => typeof value === "string"),
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

export function clearDesiredConfigOption(
  state: SessionAcpxState,
  configId: string | undefined,
): void {
  if (typeof configId !== "string" || !state.desired_config_options) {
    return;
  }
  const desired = { ...state.desired_config_options };
  delete desired[configId];
  if (Object.keys(desired).length > 0) {
    state.desired_config_options = desired;
  } else {
    delete state.desired_config_options;
  }
}

export function getDesiredModelId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModelId(state?.session_options?.model);
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
