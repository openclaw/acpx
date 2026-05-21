import path from "node:path";

function basenameToken(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, "");
}

export function isCodexAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "codex-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("codex-acp"));
}

export function isLegacyZedCodexAcpInvocation(agentCommand: string): boolean {
  return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}
