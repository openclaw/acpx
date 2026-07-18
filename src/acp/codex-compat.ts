export function isLegacyZedCodexAcpInvocation(agentCommand: string): boolean {
  return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}
