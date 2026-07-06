/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure cron-schedule helpers for the Scheduled Tasks page — building a cron
 * expression from the form's builder inputs, and turning a cron expression /
 * last-fired timestamp into a localized label. Kept free of React and of the
 * SDK task type so they can be unit-tested in isolation.
 */

export type Frequency =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'hourly'
  | 'minutes'
  | 'custom';

export interface BuilderState {
  frequency: Frequency;
  time: string; // "HH:MM"
  weekday: number; // 0..6, Sun..Sat
  minuteInterval: number;
  customCron: string;
}

/** Minimal `t()` shape — a key plus optional interpolation vars. */
export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function parseHhmm(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/** Build a 5-field cron from the builder inputs. Returns null when the inputs
 * for the chosen frequency are invalid (the caller surfaces a form error). */
export function buildCron(state: BuilderState): string | null {
  if (state.frequency === 'custom') {
    const cron = state.customCron.trim();
    return cron.length > 0 ? cron : null;
  }
  if (state.frequency === 'minutes') {
    const n = Math.floor(state.minuteInterval);
    // Only divisors of 60: `*/N` with a non-divisor (e.g. */45) is anchored to
    // the hour, so it fires at :00 and :45 then :00 again — far more often than
    // "every 45 minutes" claims. Reject non-divisors so the label stays honest.
    if (!Number.isFinite(n) || n < 1 || n > 30 || 60 % n !== 0) return null;
    return `*/${n} * * * *`;
  }
  const t = parseHhmm(state.time);
  if (!t) return null;
  switch (state.frequency) {
    case 'daily':
      return `${t.mm} ${t.hh} * * *`;
    case 'weekdays':
      return `${t.mm} ${t.hh} * * 1-5`;
    case 'weekly':
      return `${t.mm} ${t.hh} * * ${state.weekday}`;
    case 'hourly':
      return `${t.mm} * * * *`;
    default:
      return null;
  }
}

/** Human-readable schedule label, localized. Covers the shapes the builder
 * emits (the common cases in the reference design); anything else — including
 * ranges/lists a power user hand-writes — falls back to the raw expression so
 * the label is never wrong, only sometimes terse. */
export function describeCron(cron: string, t: TranslateFn): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  const pad = (n: string) => n.padStart(2, '0');

  // */N * * * *
  if (
    /^\*\/\d+$/.test(min!) &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.everyMinutes', { n: min!.slice(2) });
  }
  // M * * * *  → hourly at minute M
  if (
    isNum(min!) &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.hourly', { min: pad(min!) });
  }
  // M H * * *  → daily
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.daily', {
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  // M H * * 1-5 → weekdays
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    dow === '1-5'
  ) {
    return t('scheduledTasks.human.weekdays', {
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  // M H * * D → weekly on a single weekday. Cron allows 0 and 7 for Sunday.
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    isNum(dow!) &&
    Number(dow) >= 0 &&
    Number(dow) <= 7
  ) {
    const names = t('scheduledTasks.weekdayNames').split(',');
    const dayIndex = Number(dow) === 7 ? 0 : Number(dow);
    const name = names[dayIndex] ?? dow!;
    return t('scheduledTasks.human.weekly', {
      day: name,
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  return cron;
}

/** "Last run: …" label, or "never run" for a task that has not genuinely
 * fired. A fresh task is stamped with `lastFiredAt = floor(createdAt)` so the
 * scheduler can't fire it during its creation minute — that stamp is NOT a
 * real run, so anything at or before the creation minute reads as "never". */
export function describeLastRun(
  task: { createdAt: number; lastFiredAt: number | null },
  t: TranslateFn,
): string {
  const createdMinute = task.createdAt - (task.createdAt % 60_000);
  if (task.lastFiredAt === null || task.lastFiredAt <= createdMinute) {
    return t('scheduledTasks.never');
  }
  let when: string;
  try {
    when = new Date(task.lastFiredAt).toLocaleString();
  } catch {
    return t('scheduledTasks.never');
  }
  return t('scheduledTasks.lastFired', { when });
}
