export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function toTimerMilliseconds(seconds: number, allowZero: boolean): number | undefined {
  if (allowZero && seconds === 0) {
    return 0;
  }
  const milliseconds = Math.max(1, Math.round(seconds * 1000));
  return milliseconds <= MAX_TIMER_DELAY_MS ? milliseconds : undefined;
}
