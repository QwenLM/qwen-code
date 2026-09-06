/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Picks the later of a live and a persisted activity timestamp. The two have
 * different authorities — the live value is the bridge's running-turn terminal
 * watermark, the persisted value is the transcript's mtime — and the recorder
 * writes asynchronously, so an mtime can land a few milliseconds after the
 * terminal that produced the live value. Preferring either source blindly would
 * move the row backward in activity order. An absent or unparseable candidate
 * never displaces a valid one; when neither parses, the live candidate passes
 * through so an unparseable value is reported rather than invented.
 *
 * Every surface that reports a session's recency shares this rule, so a session
 * that is both live and persisted cannot report contradictory recency depending
 * on which route the client asked.
 */
export function laterActivityTimestamp(
  live: string | undefined,
  persisted: string | undefined,
): string | undefined {
  const liveTime = live === undefined ? Number.NaN : Date.parse(live);
  const persistedTime =
    persisted === undefined ? Number.NaN : Date.parse(persisted);
  const liveValid = Number.isFinite(liveTime);
  const persistedValid = Number.isFinite(persistedTime);
  if (liveValid && persistedValid) {
    return liveTime >= persistedTime ? live : persisted;
  }
  if (liveValid) return live;
  if (persistedValid) return persisted;
  return live ?? persisted;
}
