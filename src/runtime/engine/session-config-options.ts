import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { cloneSessionAcpxState } from "../../session/conversation-model.js";
import type { SessionRecord } from "../../types.js";

export function applyConfigOptionsToRecord(
  record: SessionRecord,
  configOptions: SessionConfigOption[] | null | undefined,
): void {
  if (!configOptions) {
    return;
  }
  const acpxState = cloneSessionAcpxState(record.acpx) ?? {};
  acpxState.config_options = structuredClone(configOptions);
  record.acpx = acpxState;
}
