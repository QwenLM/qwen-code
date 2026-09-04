/**
 * Precise timestamp for hover details: a session from the current calendar
 * day shows the local wall-clock time `HH:mm:ss`; anything older shows the
 * calendar date `yyyy-MM-dd`. Calendar days — not elapsed milliseconds — so
 * yesterday 08:01 can never masquerade as today 08:01 across midnight.
 */
export function formatDateTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (date.toDateString() === new Date(now).toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds(),
    )}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}
