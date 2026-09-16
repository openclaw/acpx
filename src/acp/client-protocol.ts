import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpElicitationMode } from "../types.js";
import { getAcpxVersion } from "../version.js";

const DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META = Object.freeze({
  "cognition.ai/requestDiagnostics": true,
});
const DEVIN_COMPATIBILITY_CLIENT_NAME = "windsurf";
// This is the embedded Windsurf IDE version bundled with Devin Desktop 3.1.7, the first locally verified version that passes Devin's server-side ACP precondition.
const DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION = "1.110.1";

export function resolveClientInfo(devinAcp: boolean): { name: string; version: string } {
  if (!devinAcp) {
    return {
      name: "acpx",
      version: getAcpxVersion(),
    };
  }

  return {
    name: DEVIN_COMPATIBILITY_CLIENT_NAME,
    version: process.env.ACPX_DEVIN_WINDSURF_VERSION ?? DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION,
  };
}

export function resolveClientCapabilities(params: {
  devinAcp: boolean;
  fs: boolean;
  terminal: boolean;
  elicitationModes: readonly AcpElicitationMode[];
}): ClientCapabilities {
  const baseCapabilities: ClientCapabilities = {
    fs: {
      readTextFile: params.fs,
      writeTextFile: params.fs,
    },
    terminal: params.terminal,
    ...(params.elicitationModes.length > 0
      ? {
          elicitation: {
            ...(params.elicitationModes.includes("form") ? { form: {} } : {}),
            ...(params.elicitationModes.includes("url") ? { url: {} } : {}),
          },
        }
      : {}),
  };

  if (!params.devinAcp) {
    return baseCapabilities;
  }

  return {
    ...baseCapabilities,
    _meta: DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META,
  };
}
