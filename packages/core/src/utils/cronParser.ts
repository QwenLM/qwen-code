/**
 * Minimal 5-field cron expression parser.
 *
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sun)
 * Supports: *, single values, steps (asterisk/N), ranges (a-b), comma lists (a,b,c)
 * No extended syntax (L, W, ?, name aliases).
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

/**
 * Parses a single cron field into a set of matching values.
 * Supports: star, single values, steps (star/N), ranges (a-b), comma lists.
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Empty field segment in "${field}"`);
    }

    // Handle step: */N or range/N or value/N
    const stepParts = trimmed.split('/');
    if (stepParts.length > 2) {
      throw new Error(`Invalid step expression: "${trimmed}"`);
    }

    let rangeStart: number;
    let rangeEnd: number;
    const base = stepParts[0]!;

    if (base === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes('-')) {
      const [startStr, endStr] = base.split('-');
      rangeStart = parseInt(startStr!, 10);
      rangeEnd = parseInt(endStr!, 10);
      if (isNaN(rangeStart) || isNaN(rangeEnd)) {
        throw new Error(`Invalid range: "${base}"`);
      }
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(`Range ${base} out of bounds [${min}-${max}]`);
      }
    } else {
      const val = parseInt(base, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Value "${base}" out of bounds [${min}-${max}]`);
      }
      rangeStart = val;
      rangeEnd = val;
    }

    const step = stepParts.length === 2 ? parseInt(stepParts[1]!, 10) : 1;
    if (isNaN(step) || step <= 0) {
      throw new Error(`Invalid step: "${stepParts[1]}"`);
    }

    for (let i = rangeStart; i <= rangeEnd; i += step) {
      values.add(i);
    }
  }

  return values;
}

/**
 * Parses a 5-field cron expression into structured fields.
 * Throws on invalid expressions.
 */
export function parseCron(cronExpr: string): CronFields {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${parts.length}: "${cronExpr}"`,
    );
  }

  return {
    minute: parseField(parts[0]!, FIELD_RANGES[0]![0], FIELD_RANGES[0]![1]),
    hour: parseField(parts[1]!, FIELD_RANGES[1]![0], FIELD_RANGES[1]![1]),
    dayOfMonth: parseField(parts[2]!, FIELD_RANGES[2]![0], FIELD_RANGES[2]![1]),
    month: parseField(parts[3]!, FIELD_RANGES[3]![0], FIELD_RANGES[3]![1]),
    dayOfWeek: parseField(parts[4]!, FIELD_RANGES[4]![0], FIELD_RANGES[4]![1]),
  };
}

/**
 * Returns true if the given date matches the cron expression.
 */
export function matches(cronExpr: string, date: Date): boolean {
  const fields = parseCron(cronExpr);
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.dayOfWeek.has(date.getDay())
  );
}

/**
 * Returns the next fire time after `after` for the given cron expression.
 * Scans forward minute-by-minute (up to ~4 years) to find the next match.
 */
export function nextFireTime(cronExpr: string, after: Date): Date {
  const fields = parseCron(cronExpr);

  // Start at the next whole minute after `after`
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Scan up to 4 years (~2.1M minutes) to avoid infinite loops
  const maxIterations = 4 * 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    if (
      fields.minute.has(candidate.getMinutes()) &&
      fields.hour.has(candidate.getHours()) &&
      fields.dayOfMonth.has(candidate.getDate()) &&
      fields.month.has(candidate.getMonth() + 1) &&
      fields.dayOfWeek.has(candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(
    `No matching fire time found within 4 years for: "${cronExpr}"`,
  );
}
