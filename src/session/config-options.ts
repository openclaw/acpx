import type { SessionConfigOption, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { SessionCreateResult, SessionLoadResult } from "../acp/client.js";
import { modelStateFromConfigOptions } from "../acp/model-support.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { cloneSessionAcpxState } from "./conversation-model.js";
import { clearDesiredConfigOption, syncAdvertisedModelState } from "./mode-preference.js";
import {
  currentModelIdFromSetModelResponse,
  type applyRequestedModelIfAdvertised,
} from "./model-application.js";
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

export function applyInitialModelSelection(
  record: SessionRecord,
  originalModels: SessionCreateResult["models"],
  modelApplication: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>,
): void {
  applyConfigOptionsToRecord(record, modelApplication.response);
  syncAdvertisedModelState(
    record,
    modelApplication.response?.configOptions !== undefined
      ? modelStateFromConfigOptions(modelApplication.response.configOptions)
      : originalModels,
  );
  if (modelApplication.applied) {
    record.acpx = applyModelSelection(
      record.acpx,
      modelApplication.modelId,
      modelApplication.response,
    );
  }
}

function applyAcceptedConfigOptions(
  state: SessionAcpxState | undefined,
  response: SetSessionConfigOptionResponse | undefined,
  selection: { configId: string | undefined; value: string },
): SessionAcpxState {
  const next = cloneSessionAcpxState(state) ?? {};
  if (response?.configOptions === undefined) {
    // Omission is an acknowledgement, not an explicit withdrawal of the catalog.
    const option = next.config_options?.find((entry) => entry.id === selection.configId);
    if (option) {
      option.currentValue = selection.value;
    }
    return next;
  }
  applyConfigOptionsModelState(next, response.configOptions);
  reconcileDesiredConfigOptions(next, response.configOptions);
  return next;
}

function reconcileDesiredConfigOptions(
  state: SessionAcpxState,
  configOptions: SessionConfigOption[],
): void {
  if (!state.desired_config_options) {
    return;
  }
  // A control response can change sibling options. Reconcile only saved
  // selections; new/load snapshots must not replace preferences with defaults.
  const desiredEntries: Array<[string, string]> = [];
  for (const option of configOptions) {
    if (
      typeof option.currentValue === "string" &&
      Object.hasOwn(state.desired_config_options, option.id)
    ) {
      desiredEntries.push([option.id, option.currentValue]);
    }
  }
  if (desiredEntries.length > 0) {
    state.desired_config_options = Object.fromEntries(desiredEntries);
  } else {
    delete state.desired_config_options;
  }
}

export function applyModelSelection(
  state: SessionAcpxState | undefined,
  modelId: string,
  response: SetSessionConfigOptionResponse | undefined,
): SessionAcpxState {
  const modelConfigId = advertisedModelState(state)?.configId;
  const next = applyAcceptedConfigOptions(state, response, {
    configId: modelConfigId,
    value: modelId,
  });
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
  next.desired_config_options = { ...next.desired_config_options, [configId]: value };
  return applyAcceptedConfigOptions(next, response, { configId, value });
}
