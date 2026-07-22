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

// A `*/N` step in the minute or hour field restarts at the top of the next
// hour/day, so "every N" is only true when N divides that unit evenly.
// `*/25` on minutes fires at :00, :25, :50 and then :00 again — a 10-minute
// gap, not 25. `*/90` is worse: every step past 59 is out of range, so only
// minute 0 survives and the job actually runs hourly.
function evenStepOf(token: string, unit: number): number | undefined {
  const n = parsePositiveInteger(token);
  if (n === undefined || unit % n !== 0) return undefined;
  return n;
}

// The day-of-month field restarts at a month boundary whose length varies, so
// no step is exactly "every N days". This only rejects steps that leave the
// 1-31 range: `*/40` matches day 1 alone, i.e. monthly, not every 40 days.
function dayStepOf(token: string): number | undefined {
  const n = parsePositiveInteger(token);
  if (n === undefined || n > 31) return undefined;
  return n;
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
    const n = evenStepOf(min!.slice(2), 60);
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
    const n = evenStepOf(hour!.slice(2), 24);
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
    const n = dayStepOf(dom!.slice(2));
    if (n !== undefined) {
      return n === 1 ? 'Every day' : `Every ${n} days`;
    }
  }

  return cronExpr;
}
