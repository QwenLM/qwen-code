const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Precise timestamp for hover details: within the last 24 hours the local
 * wall-clock time `HH:mm:ss` is the more useful precision; anything older
 * shows the calendar date `yyyy-MM-dd`.
 */
export function formatDateTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (now - date.getTime() < DAY_MS) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds(),
    )}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}
