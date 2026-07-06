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
 * Max sessions shown side by side in the split view. Each pane is a full
 * session (its own SSE + transcript), so this bounds live connections and keeps
 * panes readable. Shared so the overview caps a selection to the same limit
 * before it ever builds a `?split=` URL or opens the in-window split.
 */
export const MAX_SPLIT_PANES = 6;

/**
 * Build an absolute URL that opens the app straight into the split view for the
 * given sessions. Derived from the current location so it inherits the origin
 * and any `?daemon=`/`?token=` query a dev deployment relies on; the path is
 * reset to `/` so no single `/session/<id>` deep-link competes with the split.
 */
export function buildSplitUrl(
  sessionIds: string[],
  currentHref: string,
  token?: string,
): string {
  const url = new URL(currentHref);
  url.pathname = '/';
  url.searchParams.set(SPLIT_PARAM, sessionIds.join(','));
  // The current tab already stripped the daemon token from its URL, so carry it
  // into the new tab's fragment (never sent to the server / logs) — otherwise a
  // token-auth (`serve --open`) deployment opens the split tab unauthenticated.
  if (token) {
    url.hash = new URLSearchParams({ token }).toString();
  }
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
