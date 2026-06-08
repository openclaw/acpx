import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import { assertRequestedModelSupported } from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";

export async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
}): Promise<{
  applied: boolean;
  response?: SetSessionConfigOptionResponse;
}> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel) {
    return { applied: false };
  }
  assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
  });
  if (!params.models) {
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
