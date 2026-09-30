import type { AcpClient } from "../acp/client.js";
import { resolveRequestedConfigOption } from "../acp/model-support.js";
import { assertControlAuthority, withTimeout, type AcpControlAuthority } from "../async-control.js";
import type { SessionAcpxState } from "../types.js";
import { applyConfigOptionSelection } from "./config-options.js";
import { advertisedModelState } from "./model-state.js";

export type SessionConfigSelection = { configId: string; value: string };

export type SessionConfiguration = {
  model?: { requested: string; applied: boolean; accepted?: string };
  configOptions: Array<SessionConfigSelection & { acceptedValue: string }>;
};

export type SessionConfigurationOptions = {
  configOptions?: SessionConfigSelection[];
  onSessionConfigured?: (configuration: SessionConfiguration) => void;
};

export async function applySessionConfigOptions(params: {
  client: AcpClient;
  sessionId: string;
  agentCommand: string;
  getState: () => SessionAcpxState | undefined;
  setState: (state: SessionAcpxState | undefined) => void;
  configOptions?: SessionConfigSelection[];
  timeoutMs?: number;
  authority?: AcpControlAuthority;
}): Promise<{
  state: SessionAcpxState | undefined;
  selections: SessionConfiguration["configOptions"];
}> {
  let state = params.getState();
  const selections: SessionConfiguration["configOptions"] = [];
  for (const selection of params.configOptions ?? []) {
    assertControlAuthority(params.authority);
    const models = advertisedModelState(params.getState());
    const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
      ...selection,
      models,
      agentCommand: params.agentCommand,
    });
    const response = await withTimeout(
      params.client.setSessionConfigOption(
        params.sessionId,
        selection.configId,
        selection.value,
        models,
        params.authority,
      ),
      params.timeoutMs,
    );
    assertControlAuthority(params.authority);
    state = applyConfigOptionSelection(
      params.getState(),
      selection.configId,
      selection.value,
      response,
      modelConfigId,
      resolvedValue,
    );
    params.setState(state);
    const acceptedValue = state.config_options?.find(
      (option) => option.id === selection.configId,
    )?.currentValue;
    selections.push({
      ...selection,
      acceptedValue: typeof acceptedValue === "string" ? acceptedValue : resolvedValue,
    });
  }
  return { state, selections };
}

export function describeSessionConfiguration(params: {
  requestedModel?: string;
  modelApplied: boolean;
  state: SessionAcpxState | undefined;
  selections: SessionConfiguration["configOptions"];
}): SessionConfiguration {
  return {
    ...(params.requestedModel === undefined
      ? {}
      : {
          model: {
            requested: params.requestedModel,
            applied: params.modelApplied,
            ...(params.state?.current_model_id === undefined
              ? {}
              : { accepted: params.state.current_model_id }),
          },
        }),
    configOptions: params.selections,
  };
}
