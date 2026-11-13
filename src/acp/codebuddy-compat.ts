import { methods, type AnyMessage } from "@agentclientprotocol/sdk";

const LEGACY_PERMISSION_KINDS = new Map([
  ["allow:allow_once", "allow_once"],
  ["allow:allow_session", "allow_always"],
  ["reject:deny", "reject_once"],
]);

function isCodeBuddy(command: string, agentName: string | undefined): boolean {
  const executable = command
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(cmd|exe|ps1)$/iu, "")
    .toLowerCase();
  return executable === "codebuddy" || agentName?.toLowerCase() === "codebuddy";
}

function normalizeOption(option: unknown): unknown {
  if (!option || typeof option !== "object" || !("kind" in option) || !("optionId" in option)) {
    return option;
  }
  if (typeof option.kind !== "string" || typeof option.optionId !== "string") {
    return option;
  }
  const kind = LEGACY_PERMISSION_KINDS.get(`${option.kind}:${option.optionId}`);
  return kind ? { ...option, kind } : option;
}

/** Repair known CodeBuddy legacy kinds before ACP schema validation. */
export function normalizeCodeBuddyPermissionRequest(
  message: AnyMessage,
  command: string,
  agentName: string | undefined,
): AnyMessage {
  if (!isCodeBuddy(command, agentName)) {
    return message;
  }
  if (!("method" in message) || message.method !== methods.client.session.requestPermission) {
    return message;
  }
  const params = message.params;
  if (!params || typeof params !== "object" || !("options" in params)) {
    return message;
  }
  if (!Array.isArray(params.options)) {
    return message;
  }
  return { ...message, params: { ...params, options: params.options.map(normalizeOption) } };
}
