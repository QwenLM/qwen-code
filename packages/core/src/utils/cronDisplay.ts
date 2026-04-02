/**
 * Human-readable cron display for common recurring patterns.
 * Falls back to the raw expression for anything non-trivial.
 */
export function humanReadableCron(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;

  const [min, hour, dom, mon, dow] = parts;

  // */N * * * * → Every N minutes
  if (
    min!.startsWith('*/') &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    const n = parseInt(min!.slice(2), 10);
    if (!isNaN(n)) {
      return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }
  }

  // 0 */N * * * → Every N hours (or single minute with */N hours)
  if (
    /^\d+$/.test(min!) &&
    hour!.startsWith('*/') &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    const n = parseInt(hour!.slice(2), 10);
    if (!isNaN(n)) {
      return n === 1 ? 'Every hour' : `Every ${n} hours`;
    }
  }

  // M H */N * * → Every N days
  if (
    /^\d+$/.test(min!) &&
    /^\d+$/.test(hour!) &&
    dom!.startsWith('*/') &&
    mon === '*' &&
    dow === '*'
  ) {
    const n = parseInt(dom!.slice(2), 10);
    if (!isNaN(n)) {
      return n === 1 ? 'Every day' : `Every ${n} days`;
    }
  }

  return cronExpr;
}
