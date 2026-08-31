import type { SessionConfigOption, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { SessionCreateResult, SessionLoadResult } from "../acp/client.js";
import { modelStateFromConfigOptions } from "../acp/model-support.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { cloneSessionAcpxState } from "./conversation-model.js";
import { clearDesiredConfigOption } from "./mode-preference.js";
import { currentModelIdFromSetModelResponse } from "./model-application.js";
import { advertisedModelState, applyConfigOptionsModelState } from "./model-state.js";

type ConfigOptionsResult = Pick<SessionCreateResult | SessionLoadResult, "configOptions">;

export function applyConfigOptionsToState(
  state: SessionAcpxState | undefined,
  configOptions: SessionConfigOption[],
): SessionAcpxState {
  const acpxState: SessionAcpxState = cloneSessionAcpxState(state) ?? {};
  applyConfigOptionsModelState(acpxState, configOptions);
  return acpxState;
}

export function applyConfigOptionsToRecord(
  record: SessionRecord,
  result: ConfigOptionsResult | undefined,
): void {
  const configOptions = result?.configOptions;
  if (!configOptions) {
    return;
  }

  record.acpx = applyConfigOptionsToState(record.acpx, configOptions);
}

function applyAcceptedConfigOptions(
  state: SessionAcpxState | undefined,
  response: SetSessionConfigOptionResponse | undefined,
): SessionAcpxState {
  const next = cloneSessionAcpxState(state) ?? {};
  if (!response) {
    return next;
  }
  applyConfigOptionsModelState(next, response.configOptions);
  if (!next.desired_config_options) {
    return next;
  }
  // A control response can change sibling options. Reconcile only saved
  // selections; new/load snapshots must not replace preferences with defaults.
  const desired: Record<string, string> = {};
  for (const option of response.configOptions) {
    if (
      typeof option.currentValue === "string" &&
      Object.hasOwn(next.desired_config_options, option.id)
    ) {
      desired[option.id] = option.currentValue;
    }
  }
  if (Object.keys(desired).length > 0) {
    next.desired_config_options = desired;
  } else {
    delete next.desired_config_options;
  }
  return next;
}

export function applyModelSelection(
  state: SessionAcpxState | undefined,
  modelId: string,
  response: SetSessionConfigOptionResponse | undefined,
): SessionAcpxState {
  const modelConfigId = advertisedModelState(state)?.configId;
  const next = applyAcceptedConfigOptions(state, response);
  next.session_options = { ...next.session_options, model: modelId };
  next.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
  clearDesiredConfigOption(next, modelConfigId ?? advertisedModelState(next)?.configId);
  return next;
}

export function applyConfigOptionSelection(
  state: SessionAcpxState | undefined,
  configId: string,
  value: string,
  response: SetSessionConfigOptionResponse,
  modelConfigId = advertisedModelState(state)?.configId,
): SessionAcpxState {
  if (
    configId === modelConfigId ||
    configId === modelStateFromConfigOptions(response.configOptions)?.configId
  ) {
    return applyModelSelection(state, value, response);
  }
  const next = cloneSessionAcpxState(state) ?? {};
  if (configId === "mode") {
    next.desired_mode_id = value;
  } else {
    next.desired_config_options = { ...next.desired_config_options, [configId]: value };
  }
  return applyAcceptedConfigOptions(next, response);
}
