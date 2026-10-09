export function isRecoveryRateLimit(message: string, code?: string): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes('quota') &&
    /exhausted|exceeded/.test(lower) &&
    /will reset|reset at/.test(lower)
  ) {
    return true;
  }
  if (
    /insufficient_quota|billing|credit balance|free allocated quota/.test(lower)
  )
    return false;
  return (
    code === '429' ||
    /\b429\b/.test(message) ||
    /rate[ -]limit|too many requests/.test(lower) ||
    /用户\s*token\s*限额已触发[（(]每\d+小时[）)]/i.test(message)
  );
}

export function recoveryRetryAt(
  message: string,
  now: number,
  fallbackDelay: number,
): number {
  const delay =
    /retry(?: again)? (?:after|in) (\d+(?:\.\d+)?)\s*(seconds?|s|minutes?|m)\b/i.exec(
      message,
    );
  if (delay) {
    const milliseconds =
      Number(delay[1]) * (/^m/i.test(delay[2]) ? 60_000 : 1000);
    if (Number.isFinite(milliseconds) && milliseconds > 0)
      return now + milliseconds;
  }
  const reset =
    /reset at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:Z|\s*UTC)|\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*UTC)/i.exec(
      message,
    );
  if (reset) {
    let timestamp = reset[1].replace(/\s*UTC$/i, 'Z').replace(' ', 'T');
    if (/^\d{2}-\d{2}T/.test(timestamp)) {
      const year = new Date(now).getUTCFullYear();
      timestamp = `${year}-${timestamp}`;
      if (
        Date.parse(timestamp) < now &&
        new Date(now).getUTCMonth() === 11 &&
        timestamp.slice(5, 7) === '01'
      ) {
        timestamp = `${year + 1}${timestamp.slice(4)}`;
      }
    }
    const retryAt = Date.parse(timestamp);
    if (Number.isFinite(retryAt) && retryAt > now) return retryAt;
  }
  return now + fallbackDelay;
}
