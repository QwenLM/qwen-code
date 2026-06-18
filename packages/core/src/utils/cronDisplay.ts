/**
 * Human-readable cron display for common recurring patterns.
 * Falls back to the raw expression for anything non-trivial.
 */
function parseStepExpression(field: string): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;

  const value = Number(match[1]!);
  return value > 0 ? value : null;
}

export function humanReadableCron(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;

  const [min, hour, dom, mon, dow] = parts;

  // */N * * * * → Every N minutes
  const minuteStep = parseStepExpression(min!);
  if (
    minuteStep !== null &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return minuteStep === 1 ? 'Every minute' : `Every ${minuteStep} minutes`;
  }

  // 0 */N * * * → Every N hours (or single minute with */N hours)
  const hourStep = parseStepExpression(hour!);
  if (
    /^\d+$/.test(min!) &&
    hourStep !== null &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return hourStep === 1 ? 'Every hour' : `Every ${hourStep} hours`;
  }

  // M H */N * * → Every N days
  const dayStep = parseStepExpression(dom!);
  if (
    /^\d+$/.test(min!) &&
    /^\d+$/.test(hour!) &&
    dayStep !== null &&
    mon === '*' &&
    dow === '*'
  ) {
    return dayStep === 1 ? 'Every day' : `Every ${dayStep} days`;
  }

  return cronExpr;
}
