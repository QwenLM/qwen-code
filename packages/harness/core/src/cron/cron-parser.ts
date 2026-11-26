/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal cron expression parsing and next-run calculation.
 *
 * Supports the standard 5-field cron subset:
 *   minute hour day-of-month month day-of-week
 *
 * Field syntax: wildcard, N, step (star-slash-N), range (N-M), list (N,M,...).
 * No L, W, ?, or name aliases. All times are interpreted in the process's
 * local timezone — "0 9 * * *" means 9am wherever the CLI is running.
 *
 * @todo Consider migrating to croner library for enhanced capabilities:
 * timezone support, DST handling, seconds, L (last day) expressions.
 */

/**
 * Expanded cron expression: each field contains a sorted array of valid values.
 * All arrays are non-empty (invalid expressions return null instead of this type).
 */
export type CronFields = {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
};

type FieldRange = { min: number; max: number };

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
];

/**
 * Parse a single cron field into a sorted array of matching values.
 * Supports: wildcard, N, star-slash-N (step), N-M (range), and comma-lists.
 *
 * @param field - The cron field string to parse (e.g. "5", "1-10,20", step syntax)
 * @param range - Field range constraints with min/max boundaries
 * @returns Sorted array of matched values, or null if field is invalid/out-of-range
 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range;
  const out = new Set<number>();

  for (const part of field.split(',')) {
    // wildcard or star-slash-N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;
      if (step < 1) return null;
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }

    // N-M or N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
      // dayOfWeek: accept 7 as Sunday alias in ranges (e.g. 5-7 = Fri,Sat,Sun → [5,6,0])
      const isDow = min === 0 && max === 6;
      const effMax = isDow ? 7 : max;
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null;
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i);
      }
      continue;
    }

    // plain N
    const singleMatch = part.match(/^\d+$/);
    if (singleMatch) {
      let n = parseInt(part, 10);
      // dayOfWeek: accept 7 as Sunday alias → 0
      if (min === 0 && max === 6 && n === 7) n = 0;
      if (n < min || n > max) return null;
      out.add(n);
      continue;
    }

    return null;
  }

  if (out.size === 0) return null;
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into expanded number arrays.
 * Returns null if invalid or unsupported syntax.
 */
export function parseCronExpression(expr: string): CronFields | null {
  const CRON_FIELD_COUNT = 5;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== CRON_FIELD_COUNT) return null;

  const expanded: number[][] = [];
  for (let i = 0; i < CRON_FIELD_COUNT; i++) {
    const result = expandField(parts[i], FIELD_RANGES[i]);
    if (!result) return null;
    expanded.push(result);
  }

  return {
    minute: expanded[0],
    hour: expanded[1],
    dayOfMonth: expanded[2],
    month: expanded[3],
    dayOfWeek: expanded[4],
  };
}

/**
 * Compute the next Date strictly after `from` that matches the cron fields,
 * using the process's local timezone. Walks forward minute-by-minute. Bounded
 * at 366 days; returns null if no match (impossible for valid cron, but
 * satisfies the type).
 *
 * Standard cron semantics: when both dayOfMonth and dayOfWeek are constrained
 * (neither is the full range), a date matches if EITHER matches.
 *
 * DST: fixed-hour crons targeting a spring-forward gap (e.g. `30 2 * * *`
 * in a US timezone) skip the transition day — the gap hour never appears
 * in local time, so the hour-set check fails and the loop moves on.
 * Wildcard-hour crons (`30 * * * *`) fire at the first valid minute after
 * the gap. Fall-back repeats fire once (the step-forward logic jumps past
 * the second occurrence). This matches vixie-cron behavior.
 */
export function computeNextCronRun(
  fields: CronFields,
  from: Date,
): Date | null {
  const minuteSet = new Set(fields.minute);
  const hourSet = new Set(fields.hour);
  const domSet = new Set(fields.dayOfMonth);
  const monthSet = new Set(fields.month);
  const dowSet = new Set(fields.dayOfWeek);

  // Is the field wildcarded (full range)?
  const domWild = fields.dayOfMonth.length === 31;
  const dowWild = fields.dayOfWeek.length === 7;

  // Round up to the next whole minute (strictly after `from`)
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  // Upper bound: scan up to ~1 year of minutes (366 days × 24h × 60m).
  // If no cron match is found within this window, the expression is
  // effectively unreachable (e.g. Feb 30) and we return null.
  const MAX_LOOKAHEAD_DAYS = 366;
  const maxIter = MAX_LOOKAHEAD_DAYS * 24 * 60;
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1;
    if (!monthSet.has(month)) {
      // Jump to start of next month
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = t.getDate();
    const dow = t.getDay();
    // When both dom/dow are constrained, either match is sufficient (OR semantics)
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow);

    if (!dayMatches) {
      // Jump to start of next day
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
      continue;
    }

    return t;
  }

  return null;
}

// --- cronToHuman ------------------------------------------------------------
// Well-known shapes get a hand-written phrase because it reads better than
// anything generated. Everything else goes through describeGeneric, which
// composes a phrase field by field, so a valid expression is never shown
// without a reading.

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatLocalTime(minute: number, hour: number): string {
  // January 1 — no DST gap anywhere. Using `new Date()` (today) would roll
  // 2am→3am on the one spring-forward day per year.
  const d = new Date(2000, 0, 1, hour, minute);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "1st", "2nd", "23rd" — used for days of the month. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Join with commas and a trailing "and". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Describe one cron field's value set, e.g. `*\/15` or `1-5` or `2,4`.
 *
 * `name` renders a single numeric value (day names, month names, plain digits);
 * `unit` is the noun used when a step or range needs one.
 */
function describeField(
  field: string,
  name: (n: number) => string,
  unit: string,
): string {
  // Lists recurse so `1,3,5-7` reads as its parts joined.
  if (field.includes(',')) {
    return joinList(field.split(',').map(p => describeField(p, name, unit)));
  }

  const step = field.match(/^(.+)\/(\d+)$/);
  if (step) {
    const base = step[1];
    const n = parseInt(step[2], 10);
    const everyN = n === 1 ? `every ${unit}` : `every ${ordinal(n)} ${unit}`;
    if (base === '*') return everyN;
    return `${everyN} from ${describeField(base, name, unit)}`;
  }

  const range = field.match(/^(\d+)-(\d+)$/);
  if (range) {
    return `${name(parseInt(range[1], 10))} through ${name(
      parseInt(range[2], 10),
    )}`;
  }

  if (field === '*') return `every ${unit}`;

  const single = field.match(/^\d+$/);
  if (single) return name(parseInt(field, 10));

  // Unrecognised token: show it as-is rather than dropping information.
  return field;
}

const dayOfWeekName = (n: number) => DAY_NAMES[n % 7] ?? String(n);
const monthName = (n: number) => MONTH_NAMES[n - 1] ?? String(n);
const plainNumber = (n: number) => String(n);
/** Hours read as clock times so `0` does not surface as a bare digit. */
const hourName = (n: number) => formatLocalTime(0, n);

/**
 * Compose a reading for any 5-field expression the hand-written cases above did
 * not claim. Built from a time clause and a date clause so no valid expression
 * is left without a description.
 */
function describeGeneric(
  minute: string,
  hour: string,
  dayOfMonth: string,
  month: string,
  dayOfWeek: string,
): string {
  const minuteIsSingle = /^\d+$/.test(minute);
  const hourIsSingle = /^\d+$/.test(hour);

  let time: string;
  // Tracks whether the time clause already conveys "repeatedly through the
  // day", in which case appending "every day" would be redundant.
  let timeSpansDay = false;
  if (minuteIsSingle && hourIsSingle) {
    time = `At ${formatLocalTime(parseInt(minute, 10), parseInt(hour, 10))}`;
  } else if (minute === '*' && hour === '*') {
    time = 'Every minute';
    timeSpansDay = true;
  } else if (minute === '*') {
    time = `Every minute of ${describeField(hour, hourName, 'hour')}`;
    timeSpansDay = true;
  } else if (hour === '*') {
    time = `${describeMinuteClause(minute)} of every hour`;
    timeSpansDay = true;
  } else {
    // hourName already renders the minute as :00, so a zero minute would read
    // as "At minute 0 of 9:00 AM". Name the hours directly instead.
    time =
      minute === '0'
        ? `At ${describeField(hour, hourName, 'hour')}`
        : `${describeMinuteClause(minute)} of ${describeField(
            hour,
            hourName,
            'hour',
          )}`;
    timeSpansDay = true;
  }

  const clauses: string[] = [];
  if (dayOfMonth !== '*') {
    clauses.push(`on ${describeDayOfMonth(dayOfMonth)}`);
  }
  if (dayOfWeek !== '*') {
    clauses.push(`on ${describeField(dayOfWeek, dayOfWeekName, 'day')}`);
  }
  if (month !== '*') {
    clauses.push(`in ${describeField(month, monthName, 'month')}`);
  }
  // A single instant with no date restriction runs daily; say so, because the
  // time alone would read as a one-off. Clauses that already span the day do
  // not need it.
  if (clauses.length === 0 && !timeSpansDay) {
    clauses.push('every day');
  }

  return clauses.length > 0 ? `${time} ${clauses.join(' ')}` : time;
}

/**
 * "At minute 30", "Every 5th minute" — phrased so the word "minute" is not
 * repeated when the field is a step.
 */
function describeMinuteClause(minute: string): string {
  const step = minute.match(/^\*\/(\d+)$/);
  if (step) {
    const n = parseInt(step[1], 10);
    return n === 1 ? 'Every minute' : `Every ${ordinal(n)} minute`;
  }
  return `At minute ${describeField(minute, plainNumber, 'minute')}`;
}

/**
 * "the 15th", "every 2nd day" — the article is folded in here so a step does
 * not produce "the every 2nd day".
 */
function describeDayOfMonth(dayOfMonth: string): string {
  const step = dayOfMonth.match(/^\*\/(\d+)$/);
  if (step) {
    const n = parseInt(step[1], 10);
    return n === 1 ? 'every day' : `every ${ordinal(n)} day`;
  }
  return `the ${describeField(dayOfMonth, ordinal, 'day')}`;
}

/**
 * Convert a 5-field cron expression into a human-readable description.
 * Covers common patterns; falls through to the raw cron string for uncommon ones.
 */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Every N minutes: step/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (
    everyMinMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Every hour: 0 * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10);
    if (m === 0) return 'Every hour';
    return `Every hour at :${m.toString().padStart(2, '0')}`;
  }

  // Every N hours: 0 step/N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1], 10);
    const m = parseInt(minute, 10);
    const suffix = m === 0 ? '' : ` at :${m.toString().padStart(2, '0')}`;
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
  }

  // --- Remaining cases reference hour+minute ---------------------------------

  // --- Remaining hand-written cases reference a single hour+minute ----------

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) {
    return describeGeneric(minute, hour, dayOfMonth, month, dayOfWeek);
  }
  const m = parseInt(minute, 10);
  const h = parseInt(hour, 10);

  // Daily at specific time: M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${formatLocalTime(m, h)}`;
  }

  // Specific day of week: M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7; // normalize 7 (Sunday alias) -> 0
    const dayName = DAY_NAMES[dayIndex];
    if (dayName) return `Every ${dayName} at ${formatLocalTime(m, h)}`;
  }

  // Weekdays: M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${formatLocalTime(m, h)}`;
  }

  return describeGeneric(minute, hour, dayOfMonth, month, dayOfWeek);
}
