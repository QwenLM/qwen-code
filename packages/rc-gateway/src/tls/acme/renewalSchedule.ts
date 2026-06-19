/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure renewal-timing policy for ACME-managed certs. Let's Encrypt certs are
 * valid 90 days; we renew `renewBeforeDays` (default 30) before `notAfter`, so a
 * healthy cert is replaced with ~30 days of slack — enough headroom to retry
 * transient DNS/ACME failures without ever serving an expired cert.
 *
 * No I/O, no ambient clock, no randomness: the caller passes `now` (the scheduler
 * injects the real `Date`), keeping this trivially unit-testable. Jitter, if any,
 * belongs in the scheduler that consumes `msUntilRenewal`, not here.
 */

export const DEFAULT_RENEW_BEFORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant (ms epoch) at which renewal becomes due. */
function renewalPoint(notAfter: Date, renewBeforeDays: number): number {
  return notAfter.getTime() - renewBeforeDays * DAY_MS;
}

/** True once `now` has reached the renewal point (`notAfter - renewBeforeDays`). */
export function shouldRenew(
  notAfter: Date,
  now: Date,
  renewBeforeDays: number = DEFAULT_RENEW_BEFORE_DAYS,
): boolean {
  return now.getTime() >= renewalPoint(notAfter, renewBeforeDays);
}

/**
 * Milliseconds from `now` until the renewal point, floored at 0 — 0 means "renew
 * now" (including an already-expired cert). The scheduler arms a timer for this.
 */
export function msUntilRenewal(
  notAfter: Date,
  now: Date,
  renewBeforeDays: number = DEFAULT_RENEW_BEFORE_DAYS,
): number {
  return Math.max(0, renewalPoint(notAfter, renewBeforeDays) - now.getTime());
}
