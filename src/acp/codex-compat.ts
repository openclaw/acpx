import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export function isLegacyZedCodexAcpInvocation(agentCommand: string): boolean {
  return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}

export function preferCodexPermissionRefusal(
  request: RequestPermissionRequest,
  agentName: string | undefined,
): RequestPermissionRequest {
  if (agentName !== "@agentclientprotocol/codex-acp") {
    return request;
  }
  const preferred = request.options.find(
    (option) =>
      option.kind === "reject_once" && ["decline", "reject_permissions"].includes(option.optionId),
  );
  return preferred
    ? {
        ...request,
        options: [preferred, ...request.options.filter((option) => option !== preferred)],
      }
    : request;
}

export function codexPermissionNotice(
  request: RequestPermissionRequest,
  response: RequestPermissionResponse,
  agentName: string | undefined,
): string | undefined {
  if (agentName !== "@agentclientprotocol/codex-acp") {
    return undefined;
  }
  if (response.outcome.outcome === "cancelled") {
    return "No matching permission option was available. The request was safely cancelled; Codex may end the current turn.";
  }
  const selectedId = response.outcome.optionId;
  const option = request.options.find((option) => option.optionId === selectedId);
  return option?.kind === "reject_once" && selectedId === "cancel"
    ? "Permission refused using Codex's cancellation option; this can end the current turn. The operation was not approved."
    : undefined;
}
