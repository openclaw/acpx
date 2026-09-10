import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import {
  assertRequestedModelSupported,
  modelStateFromConfigOptions,
  supportsStartupModelFlag,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";

function modelAppliedAtLaunch(
  client: AcpClient,
  agentCommand: string | undefined,
  requestedModel: string,
): boolean {
  return supportsStartupModelFlag(agentCommand) && client.getStartupModel() === requestedModel;
}

function emitStartupFlagUnavailableWarning(params: {
  requestedModel: string;
  appliedViaStartupFlag: boolean;
  agentCommand?: string;
  onWarning?: (message: string) => void;
}): void {
  if (params.appliedViaStartupFlag || !supportsStartupModelFlag(params.agentCommand)) {
    return;
  }
  params.onWarning?.(
    `requested model "${params.requestedModel}" was not applied to this running session; the adapter applies model selection at process startup, so a new session is required to change it.`,
  );
}

export function currentModelIdFromSetModelResponse(
  response: SetSessionConfigOptionResponse | undefined,
  fallbackModelId: string | undefined,
): string | undefined {
  return modelStateFromConfigOptions(response?.configOptions)?.currentModelId ?? fallbackModelId;
}

export async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}): Promise<{
  applied: boolean;
  response?: SetSessionConfigOptionResponse;
}> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel) {
    return { applied: false };
  }
  const appliedViaStartupFlag = modelAppliedAtLaunch(
    params.client,
    params.agentCommand,
    requestedModel,
  );
  const warning = assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
    appliedViaStartupFlag,
  });
  if (warning) {
    params.onWarning?.(warning);
  }
  // A model delivered through a startup flag counts as applied when this client
  // process was actually launched with it. A reused queue client keeps ACP
  // model controls so later --model requests still reach the running adapter.
  if (!params.models) {
    emitStartupFlagUnavailableWarning({
      requestedModel,
      appliedViaStartupFlag,
      agentCommand: params.agentCommand,
      onWarning: params.onWarning,
    });
    return { applied: appliedViaStartupFlag };
  }
  if (appliedViaStartupFlag || params.models.currentModelId === requestedModel) {
    return { applied: true };
  }

  const response = await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel, params.models),
    params.timeoutMs,
  );
  return { applied: true, response };
}
