export const TURN_COUNT = 103;
export const LONG_TURN = 51;
export const CHECKPOINT_COUNTS = [99, 100, 101] as const;
export const LONG_SUFFIX = "LOSSLESS_VIEWER_FINAL_SUFFIX";
export const PRODUCER_TIMEOUT_MS = 360_000;
export const PRODUCER_TERM_GRACE_MS = 10_000;
export const PRODUCER_KILL_GRACE_MS = 5_000;
export const PEER_RETIREMENT_GRACE_MS = 5_000;
export const CAPTURE_FAILURE_BOUND_MS =
  PRODUCER_TIMEOUT_MS + PRODUCER_TERM_GRACE_MS + PRODUCER_KILL_GRACE_MS + PEER_RETIREMENT_GRACE_MS;

export function answerForTurn(index: number): string {
  if (index === LONG_TURN) {
    return `${"x".repeat(8_101)}\n${LONG_SUFFIX}`;
  }
  if (index === 0 || index === TURN_COUNT - 1) {
    return `answer-${index}`;
  }
  return "identical-answer";
}

export function promptForTurn(index: number): string {
  return `echo ${answerForTurn(index)}`;
}

export function nodeForTurn(index: number): string {
  return `turn_${String(index).padStart(3, "0")}`;
}
