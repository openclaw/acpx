import fastJsonPatch from "fast-json-patch";
import type { ReplayJsonPatchOperation } from "../types";

const { applyPatch } = fastJsonPatch;

export function buildReplayWebSocketUrl(currentUrl: string = window.location.href): string {
  const url = new URL(currentUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/live";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function applyReplayPatch<TState extends object>(
  state: TState,
  ops: ReplayJsonPatchOperation[],
): TState {
  return applyPatch(structuredClone(state), ops).newDocument as TState;
}
