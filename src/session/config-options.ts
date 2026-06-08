import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionCreateResult, SessionLoadResult } from "../acp/client.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { cloneSessionAcpxState } from "./conversation-model.js";
import { applyConfigOptionsModelState } from "./model-state.js";

type ConfigOptionsResult = Pick<SessionCreateResult | SessionLoadResult, "configOptions">;

export function applyConfigOptionsToState(
  state: SessionAcpxState | undefined,
  configOptions: SessionConfigOption[],
): SessionAcpxState {
  const acpxState: SessionAcpxState = cloneSessionAcpxState(state) ?? {};
  applyConfigOptionsModelState(acpxState, configOptions);
  return acpxState;
}

export function applyConfigOptionsToRecord(
  record: SessionRecord,
  result: ConfigOptionsResult | undefined,
): void {
  const configOptions = result?.configOptions;
  if (!configOptions) {
    return;
  }

  record.acpx = applyConfigOptionsToState(record.acpx, configOptions);
}
