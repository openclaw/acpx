import { MAX_TIMER_DELAY_MS } from "../cli/timer-duration.js";

export function resolveFlowTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`timeoutMs must be a finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return timeoutMs > 0 ? timeoutMs : undefined;
}
