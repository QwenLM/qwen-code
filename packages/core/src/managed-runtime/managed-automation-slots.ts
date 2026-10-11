/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ManagedSessionRecordError } from './managed-session-records.js';

// H6b of #12827: the slot evaluator of a Schedule definition — the minute
// instants in a window at which a five-field cron fires in an IANA zone.
// The Java scanner (`CronSlots` in packages/sdk-java/managed-agent-server)
// is the production evaluator; this twin pins the semantics as a contract
// through contracts/managed-automation-slots-v1.fixtures.json, which both
// replay. See docs/design/2026-10-07-managed-automation-runtime.md,
// decision 9.

const MINUTE_MS = 60_000;
/** The offset probe behind a candidate instant; no zone folds twice in it. */
const FOLD_PROBE_MINUTES = 180;

export interface CronMatcher {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /** Vixie day semantics: a day field that starts with `*` is wild. */
  readonly dayOfMonthWild: boolean;
  readonly dayOfWeekWild: boolean;
}

/** The wall clock of one instant in one zone, with its offset. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 is Sunday. */
  readonly weekday: number;
  readonly offsetMinutes: number;
}

const BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

// Exactly the atoms the H6a contract grammar and the Java evaluator
// accept: ASCII digits only, one optional range part, one optional step.
const CRON_ATOM = /^(?:\*|[0-9]{1,10}(?:-[0-9]{1,10})?)(?:\/[0-9]{1,10})?$/;

function values(field: string, min: number, max: number): Set<number> {
  const set = new Set<number>();
  for (const atom of field.split(',')) {
    if (!CRON_ATOM.test(atom)) fail(`cron atom ${atom} is malformed.`);
    const [base, stepText] = atom.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    let from: number;
    let to: number;
    if (base === '*') {
      from = min;
      to = max;
    } else if (base!.includes('-')) {
      const [left, right] = base!.split('-');
      from = Number(left);
      to = Number(right);
      // The contract refuses a range that wraps or has equal ends.
      if (!(from < to)) fail(`cron atom ${atom} is not an ascending range.`);
    } else {
      from = Number(base);
      // Vixie: `N/step` runs from N to the field maximum.
      to = stepText === undefined ? from : max;
    }
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      !Number.isInteger(step) ||
      step < 1 ||
      from < min ||
      to > max ||
      from > to
    ) {
      fail(`cron atom ${atom} is outside ${min}-${max}.`);
    }
    for (let value = from; value <= to; value += step) set.add(value);
  }
  return set;
}

/**
 * Compiles a five-field cron the H6a contract accepted. The grammar is the
 * contract's; this only expands it into the matched values.
 */
export function compileCron(expression: string): CronMatcher {
  const fields = expression.split(' ');
  if (fields.length !== 5) fail('cron must have exactly five fields.');
  const [minute, hour, dayOfMonth, month, dayOfWeekRaw] = fields.map(
    (field, index) => values(field, BOUNDS[index]![0], BOUNDS[index]![1]),
  );
  const dayOfWeek = new Set(dayOfWeekRaw!);
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return Object.freeze({
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek,
    dayOfMonthWild: fields[2]!.startsWith('*'),
    dayOfWeekWild: fields[4]!.startsWith('*'),
  });
}

/** Whether one wall-clock minute matches, under Vixie day semantics. */
export function cronMatches(
  matcher: CronMatcher,
  wall: Pick<WallClock, 'minute' | 'hour' | 'day' | 'month' | 'weekday'>,
): boolean {
  if (
    !matcher.minute.has(wall.minute) ||
    !matcher.hour.has(wall.hour) ||
    !matcher.month.has(wall.month)
  ) {
    return false;
  }
  const dayOfMonth = matcher.dayOfMonth.has(wall.day);
  const dayOfWeek = matcher.dayOfWeek.has(wall.weekday);
  return !matcher.dayOfMonthWild && !matcher.dayOfWeekWild
    ? dayOfMonth || dayOfWeek
    : dayOfMonth && dayOfWeek;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

// ICU resolves these three short ids, but `ZoneId.getAvailableZoneIds()`
// — the production evaluator's acceptance set — refuses them. A full
// host-tz sweep found no other divergence between the two authorities.
const JAVA_UNKNOWN_ZONES = new Set(['EST', 'HST', 'MST']);

/** Whether the host's tz database resolves the zone name. */
export function resolvesTimezone(timeZone: string): boolean {
  if (JAVA_UNKNOWN_ZONES.has(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `instantMs` in `timeZone`. */
export function wallClock(instantMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const year = parts['year']!;
  const month = parts['month']!;
  const day = parts['day']!;
  const hour = parts['hour']! % 24;
  const minute = parts['minute']!;
  const localMs = Date.UTC(year, month - 1, day, hour, minute);
  // `localMs` drops the sub-minute fraction `formatToParts` never carries,
  // so the subtraction must align to the same minute or a trailing
  // fraction over 30 s biases the offset by one minute.
  const aligned = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return Object.freeze({
    year,
    month,
    day,
    hour,
    minute,
    weekday: new Date(localMs).getUTCDay(),
    offsetMinutes: Math.round((localMs - aligned) / MINUTE_MS),
  });
}

/** The wall clock as a count of local minutes, comparable across days. */
function localMinutes(wall: WallClock): number {
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) /
    MINUTE_MS
  );
}

function wallOfLocalMinutes(local: number): WallClock {
  const date = new Date(local * MINUTE_MS);
  return Object.freeze({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay(),
    offsetMinutes: 0,
  });
}

export interface AutomationSlotWindow {
  readonly cron: string;
  readonly timezone: string;
  /** Exclusive: the covered watermark or the arming instant, epoch ms. */
  readonly afterMs: number;
  /** Inclusive, epoch ms. */
  readonly untilMs: number;
  /** The newest slots kept when the window holds more. */
  readonly limit: number;
}

export interface AutomationSlots {
  /** Epoch ms of each slot, oldest first, each a whole minute. */
  readonly slots: readonly number[];
  /** The window held more than `limit` slots; the oldest were cut. */
  readonly truncated: boolean;
}

/**
 * The instants in `(afterMs, untilMs]` at which the cron fires, read in the
 * definition's zone. Each UTC minute instant is tested once; a wall-clock
 * minute a DST gap skipped fires once at the first instant after the gap,
 * and a wall-clock minute a DST fold repeats fires once, at its first
 * instant (decision 9).
 */
export function automationSlots(window: AutomationSlotWindow): AutomationSlots {
  const matcher = compileCron(window.cron);
  if (!resolvesTimezone(window.timezone)) {
    fail(`timezone ${window.timezone} does not resolve on this host.`);
  }
  if (
    !Number.isSafeInteger(window.limit) ||
    window.limit < 1 ||
    !Number.isFinite(window.afterMs) ||
    !Number.isFinite(window.untilMs)
  ) {
    fail('slot window needs a positive limit and finite bounds.');
  }
  const slots: number[] = [];
  const first = Math.floor(window.afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const last = Math.floor(window.untilMs / MINUTE_MS) * MINUTE_MS;
  for (let instant = first; instant <= last; instant += MINUTE_MS) {
    if (isSlot(matcher, window.timezone, instant)) slots.push(instant);
  }
  if (slots.length > window.limit) {
    return Object.freeze({
      slots: Object.freeze(slots.slice(slots.length - window.limit)),
      truncated: true,
    });
  }
  return Object.freeze({ slots: Object.freeze(slots), truncated: false });
}

/** Whether one whole-minute instant is a slot of the cron in the zone. */
export function isSlot(
  matcher: CronMatcher,
  timeZone: string,
  instantMs: number,
): boolean {
  const wall = wallClock(instantMs, timeZone);
  const before = wallClock(instantMs - MINUTE_MS, timeZone);
  // A fold repeats wall-clock minutes: this instant is the second reading
  // of its minute when an earlier instant, one pre-transition offset back,
  // read the same wall clock.
  const probe = wallClock(instantMs - FOLD_PROBE_MINUTES * MINUTE_MS, timeZone);
  const drop = probe.offsetMinutes - wall.offsetMinutes;
  if (
    drop > 0 &&
    wallClock(instantMs - drop * MINUTE_MS, timeZone).offsetMinutes ===
      wall.offsetMinutes + drop
  ) {
    return false;
  }
  if (cronMatches(matcher, wall)) return true;
  // A gap skips wall-clock minutes: the first instant after it fires for
  // any skipped minute the cron names, once.
  const local = localMinutes(wall);
  const previous = localMinutes(before);
  for (let skipped = previous + 1; skipped < local; skipped += 1) {
    if (cronMatches(matcher, wallOfLocalMinutes(skipped))) return true;
  }
  return false;
}

/** The canonical `schedule:<slot>` occurrence key of a slot instant. */
export function slotOccurrenceKey(slotMs: number): string {
  if (!Number.isSafeInteger(slotMs) || slotMs % MINUTE_MS !== 0) {
    fail('a slot is a whole-minute epoch instant.');
  }
  return `schedule:${new Date(slotMs).toISOString().slice(0, 19)}Z`;
}
