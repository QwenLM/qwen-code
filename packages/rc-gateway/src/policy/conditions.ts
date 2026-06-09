/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure time-condition helpers for the policy evaluator. No I/O; all functions
 * read only their arguments (the clock is injected as `now`). A condition that
 * cannot be parsed returns `null` (timeOfDay) / `null` (expiresAt) so the
 * evaluator can classify it as `unevaluable` and apply the safety downgrade —
 * we never auto-decide on a constraint we could not evaluate.
 */

export interface ParsedTimeOfDay {
  fromMin: number;
  toMin: number;
  timezone: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Convert a validated "HH:MM" string to minutes-of-day (0–1439). */
function hhmmToMinutes(s: string): number {
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(3, 5));
  return h * 60 + m;
}

/**
 * Parse a raw `match.timeOfDay` value into minutes-of-day + a validated IANA
 * timezone, or `null` when malformed. "Malformed" is a single concept (parse →
 * null): we validate the timezone HERE, by probing it with a throwaway
 * `Intl.DateTimeFormat` in try/catch (an invalid IANA zone throws `RangeError`).
 * As a consequence, {@link isWithinTimeOfDay} receives an already-validated zone
 * and its own try/catch around `Intl` is belt-and-suspenders.
 */
export function parseTimeOfDay(raw: unknown): ParsedTimeOfDay | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const from = obj['from'];
  const to = obj['to'];
  const timezone = obj['timezone'];
  if (typeof from !== 'string' || !HHMM.test(from)) return null;
  if (typeof to !== 'string' || !HHMM.test(to)) return null;
  if (typeof timezone !== 'string' || timezone.length === 0) return null;
  // Probe the zone: an invalid IANA zone makes Intl throw → malformed.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  return {
    fromMin: hhmmToMinutes(from),
    toMin: hhmmToMinutes(to),
    timezone,
  };
}

/**
 * True when `now`, projected into `p.timezone`, falls inside the window
 * (inclusive of both `from` and `to`). The window wraps midnight when
 * `fromMin > toMin` (e.g. 23:00–07:00 = the night window). Projection via
 * `Intl.DateTimeFormat` handles DST correctly. The zone is already validated by
 * {@link parseTimeOfDay}, so the try/catch here is defensive only; on the
 * (unreachable) throw we conservatively return false.
 */
export function isWithinTimeOfDay(p: ParsedTimeOfDay, now: Date): boolean {
  let h: number;
  let min: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: p.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hourPart = parts.find((x) => x.type === 'hour')?.value ?? '0';
    const minutePart = parts.find((x) => x.type === 'minute')?.value ?? '0';
    // Some environments emit "24" for midnight under hour12:false — normalize.
    h = hourPart === '24' ? 0 : Number(hourPart);
    min = Number(minutePart);
  } catch {
    return false;
  }
  const m = h * 60 + min;
  return p.fromMin <= p.toMin
    ? m >= p.fromMin && m <= p.toMin
    : m >= p.fromMin || m <= p.toMin;
}

/**
 * Parse a raw `expiresAt` value to epoch milliseconds, or `null` when malformed.
 * Only strings are accepted; a non-string (number/object/null, or a bare
 * `expiresAt:` YAML key → null in JS) is malformed.
 */
export function parseExpiresAt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** True when `now` is at or after the expiry instant (strict-future = valid). */
export function isExpired(expiresMs: number, now: Date): boolean {
  return now.getTime() >= expiresMs;
}
