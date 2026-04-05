import type { AcpRuntimeHandle } from "./contract.js";
import type { AcpxHandleState } from "./shared.js";
import { asOptionalString } from "./shared.js";

const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v2:";

export function encodeAcpxRuntimeHandleState(state: AcpxHandleState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${ACPX_RUNTIME_HANDLE_PREFIX}${payload}`;
}

export function decodeAcpxRuntimeHandleState(runtimeSessionName: string): AcpxHandleState | null {
  const trimmed = runtimeSessionName.trim();
  if (!trimmed.startsWith(ACPX_RUNTIME_HANDLE_PREFIX)) {
    return null;
  }
  try {
    const raw = Buffer.from(trimmed.slice(ACPX_RUNTIME_HANDLE_PREFIX.length), "base64url").toString(
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = asOptionalString(parsed.name);
    const agent = asOptionalString(parsed.agent);
    const cwd = asOptionalString(parsed.cwd);
    const mode = asOptionalString(parsed.mode);
    if (!name || !agent || !cwd || (mode !== "persistent" && mode !== "oneshot")) {
      return null;
    }
    return {
      name,
      agent,
      cwd,
      mode,
      acpxRecordId: asOptionalString(parsed.acpxRecordId),
      backendSessionId: asOptionalString(parsed.backendSessionId),
      agentSessionId: asOptionalString(parsed.agentSessionId),
    };
  } catch {
    return null;
  }
}

export function writeHandleState(handle: AcpRuntimeHandle, state: AcpxHandleState): void {
  handle.runtimeSessionName = encodeAcpxRuntimeHandleState(state);
  handle.cwd = state.cwd;
  handle.acpxRecordId = state.acpxRecordId;
  handle.backendSessionId = state.backendSessionId;
  handle.agentSessionId = state.agentSessionId;
}
