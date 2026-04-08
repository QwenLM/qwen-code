/**
 * Minimal 5-field cron expression parser.
 *
 * Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-7, 0 and 7=Sun)
 * Supports: *, single values, steps (asterisk/N), ranges (a-b), comma lists (a,b,c)
 * No extended syntax (L, W, ?, name aliases).
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the day-of-month field was literally '*' (unrestricted). */
  domIsWild: boolean;
  /** True when the day-of-week field was literally '*' (unrestricted). */
  dowIsWild: boolean;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both mean Sunday)
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

  // Parse day-of-week with range 0-7, then normalize 7 → 0 (both mean Sunday)
  const dayOfWeek = parseField(
    parts[4]!,
    FIELD_RANGES[4]![0],
    FIELD_RANGES[4]![1],
  );
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }

  return {
    minute: parseField(parts[0]!, FIELD_RANGES[0]![0], FIELD_RANGES[0]![1]),
    hour: parseField(parts[1]!, FIELD_RANGES[1]![0], FIELD_RANGES[1]![1]),
    dayOfMonth: parseField(parts[2]!, FIELD_RANGES[2]![0], FIELD_RANGES[2]![1]),
    month: parseField(parts[3]!, FIELD_RANGES[3]![0], FIELD_RANGES[3]![1]),
    dayOfWeek,
    domIsWild: parts[2]!.trim() === '*',
    dowIsWild: parts[4]!.trim() === '*',
  };
}

/**
 * Returns true if the given date matches the cron expression.
 *
 * Follows vixie-cron day semantics: when both day-of-month and day-of-week
 * are constrained (neither is `*`), the date matches if EITHER field matches.
 * When only one is constrained, it must match.
 */
export function matches(cronExpr: string, date: Date): boolean {
  const fields = parseCron(cronExpr);

  if (
    !fields.minute.has(date.getMinutes()) ||
    !fields.hour.has(date.getHours()) ||
    !fields.month.has(date.getMonth() + 1)
  ) {
    return false;
  }

  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());

  // Vixie-cron: if both day-of-month and day-of-week are restricted,
  // match if EITHER is satisfied. Otherwise use AND.
  if (!fields.domIsWild && !fields.dowIsWild) {
    return domMatch || dowMatch;
  }

  return domMatch && dowMatch;
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
    const minuteOk = fields.minute.has(candidate.getMinutes());
    const hourOk = fields.hour.has(candidate.getHours());
    const monthOk = fields.month.has(candidate.getMonth() + 1);
    const domOk = fields.dayOfMonth.has(candidate.getDate());
    const dowOk = fields.dayOfWeek.has(candidate.getDay());

    // Vixie-cron day semantics: OR when both constrained, AND otherwise
    const dayOk =
      !fields.domIsWild && !fields.dowIsWild ? domOk || dowOk : domOk && dowOk;

    if (minuteOk && hourOk && monthOk && dayOk) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(
    `No matching fire time found within 4 years for: "${cronExpr}"`,
  );
}
