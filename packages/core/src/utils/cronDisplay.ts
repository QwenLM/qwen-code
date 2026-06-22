/**
 * Human-readable cron display for common recurring patterns.
 * Falls back to the raw expression for anything non-trivial.
 */
const INTEGER_TOKEN_RE = /^\d+$/;

function parsePositiveInteger(token: string): number | undefined {
  if (!INTEGER_TOKEN_RE.test(token)) return undefined;
  const value = parseInt(token, 10);
  return value > 0 ? value : undefined;
}

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
    const n = parsePositiveInteger(min!.slice(2));
    if (n !== undefined) {
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
    const n = parsePositiveInteger(hour!.slice(2));
    if (n !== undefined) {
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
    const n = parsePositiveInteger(dom!.slice(2));
    if (n !== undefined) {
      return n === 1 ? 'Every day' : `Every ${n} days`;
    }
  }

  return cronExpr;
}
