/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * URL helpers for opening the split view (2+ sessions side by side) in its own
 * browser tab. A `?split=<id>,<id>` query tells the app to enter the split view
 * with those sessions on load; the overview opens such a URL with `_blank` so
 * the split lands in a new tab instead of replacing the current one.
 */

const SPLIT_PARAM = 'split';

/**
 * Build an absolute URL that opens the app straight into the split view for the
 * given sessions. Derived from the current location so it inherits the origin
 * and any `?daemon=`/`?token=` query a dev deployment relies on; the path is
 * reset to `/` so no single `/session/<id>` deep-link competes with the split.
 */
export function buildSplitUrl(
  sessionIds: string[],
  currentHref: string,
): string {
  const url = new URL(currentHref);
  url.pathname = '/';
  url.searchParams.set(SPLIT_PARAM, sessionIds.join(','));
  return url.toString();
}

/** Read the session ids from a `?split=a,b,c` query string (empty when absent). */
export function parseSplitSessionIds(search: string): string[] {
  const raw = new URLSearchParams(search).get(SPLIT_PARAM);
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}
