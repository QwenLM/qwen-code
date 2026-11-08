/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixed capture viewport — the single source of truth shared by
 * playwright.visuals.config.ts and the visuals harness/specs, so the value
 * cannot drift between the config and what actually renders.
 */
export const VISUAL_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Wall-clock instant every capture renders at.
 *
 * It is deliberately in the FUTURE relative to every date a fixture hardcodes.
 * Relative formatters measure `Date.now() - value` (`formatRelativeTime`), so a
 * fixture date on the far side of this instant yields a negative age and
 * collapses to "just now": with an earlier constant the channel editor's
 * pairing requests, dated 2026-07-28, rendered as "just now" instead of the
 * "7/28/2026" the real clock produced. Future-dating is the safe direction --
 * a fixture then reads as older than now, which is what every one of them
 * means.
 *
 * Two rules follow for anyone adding a fixture. An absolute date must be
 * earlier than this instant. A value meant to be "now" must be derived from
 * this constant rather than from `Date.now()`, which in a spec runs on Node's
 * real clock and lands months away from the page's frozen one.
 *
 * It lives here rather than in harness.ts so `visual-capture-contracts.test.ts`
 * -- the gating vitest guard for both rules -- can import it without pulling in
 * `@playwright/test`.
 */
export const FIXED_CAPTURE_TIME = new Date('2027-01-01T09:00:00.000Z');
