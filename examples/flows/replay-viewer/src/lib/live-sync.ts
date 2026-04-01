import { applyReplayPatch } from "./json-patch-plus.js";

export function buildReplayWebSocketUrl(currentUrl: string = window.location.href): string {
  const url = new URL(currentUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/live";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export { applyReplayPatch };
