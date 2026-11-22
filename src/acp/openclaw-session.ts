import { basenameToken, resolveAgentCommandParts } from "./client-process.js";

export function isOpenClawAcpAgent(
  agentCommand: string,
  agentArgv?: string[],
  agentName?: string,
): boolean {
  if (agentName === "openclaw-acp") {
    return true;
  }
  const { command, args } = resolveAgentCommandParts(agentCommand, agentArgv);
  return basenameToken(command) === "openclaw" && args.includes("acp");
}

export function openClawResumeMeta(
  sessionId: string,
  agentCommand: string,
  agentArgv?: string[],
): Record<string, unknown> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId);
  const { args } = resolveAgentCommandParts(agentCommand, agentArgv);
  const explicitRouting = args.some((arg) => /^--session(?:-label)?(?:=|$)/u.test(arg));
  return {
    ...(!(isUuid && explicitRouting)
      ? { sessionKey: isUuid ? `acp-bridge:${sessionId}` : sessionId }
      : {}),
    requireExisting: true,
  };
}
