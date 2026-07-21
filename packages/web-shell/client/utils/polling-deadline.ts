export function remainingPollingTimeout(
  deadlineAt: number,
  maxRequestMs = 30_000,
): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Operation polling timed out');
  return Math.min(remaining, maxRequestMs);
}

export function nextPollingDelay(deadlineAt: number, delayMs: number): number {
  return Math.min(remainingPollingTimeout(deadlineAt, delayMs), delayMs);
}
