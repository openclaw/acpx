import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import {
  assertRequestedModelSupported,
  modelStateFromConfigOptions,
  supportsStartupModelFlag,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";

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
  const warning = assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
  });
  if (warning) {
    params.onWarning?.(warning);
  }
  // Startup-flag adapters (Devin, fx) already received the model at process
  // launch; re-asserting through session/set_config_option can reject
  // adapter-resolved fuzzy names the flag already applied.
  if (!params.models || supportsStartupModelFlag(params.agentCommand)) {
    return { applied: false };
  }
  if (params.models.currentModelId === requestedModel) {
    return { applied: true };
  }

  const response = await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel, params.models),
    params.timeoutMs,
  );
  return { applied: true, response };
}
