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

// The day-of-month field restarts at day 1 of a month whose length varies, so
// nothing but 1 divides it evenly and "every N days" is never true for N > 1.
// The shortfall is not confined to large steps: `*/2` fires on days 1, 3 … 31
// and then day 1 again, a 1-day gap, and `*/15` fires on 1, 16, 31 with the
// same 1-day rollover. Large steps are not even the worst offenders — `*/16`
// fires on 1 and 17, whose shortest gap is 12 days — while `*/31` matches day
// 1 alone and is really monthly. No cutoff makes the label truthful, so only
// `*/1` keeps one.
function isEveryDayStep(token: string): boolean {
  return parsePositiveInteger(token) === 1;
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

  // M H */1 * * → Every day
  if (
    /^\d+$/.test(min!) &&
    /^\d+$/.test(hour!) &&
    dom!.startsWith('*/') &&
    mon === '*' &&
    dow === '*' &&
    isEveryDayStep(dom!.slice(2))
  ) {
    return 'Every day';
  }

  return cronExpr;
}
