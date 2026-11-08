/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildSessionPathname } from './sessionPath';

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
 * and any `?daemon=`/`?token=` query a dev deployment relies on; the trailing
 * `/session/<id>` deep-link is stripped while preserving any deployment base
 * path, so no single session competes with the split.
 */
export function buildSplitUrl(
  sessionIds: string[],
  currentHref: string,
  token?: string,
): string {
  const url = new URL(currentHref);
  url.pathname = buildSessionPathname(url.pathname, undefined);
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

const SPLIT_STORAGE_KEY = 'qwen-webshell-split-sessions';
const SPLIT_OWNER_KEY = 'qwen-webshell-split-sessions-for';

/**
 * The daemon target this document is pointed at.
 *
 * `sessionStorage` is partitioned by the PAGE origin, and a `?daemon=` switch
 * changes only the query — so one storage is shared by every target this tab
 * has visited. Tagging the saved set with the target it belongs to is what
 * stops a target change that never passes through `navigateToDaemon` (history
 * Back/Forward, a bookmark, an address-bar edit, a hand-built link) from
 * restoring the previous daemon's session ids into the next one.
 *
 * Deliberately a plain parse rather than `getAllowedDaemonOrigin`: this tags
 * state ownership, it does not decide what to connect to, and importing
 * `config/daemon` here would be circular (it imports `clearSplitSessions`). A
 * tag that does not match the live target drops the set, which is the safe
 * direction — the operator loses a restored split, never gains a foreign one.
 */
function splitOwner(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get('daemon');
    return raw
      ? new URL(raw, window.location.origin).origin
      : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/**
 * Persist the in-window split's session set so a refresh restores it. Uses
 * `sessionStorage` (not `localStorage`) on purpose: it is scoped per browser
 * tab, so a split opened in its own tab (via {@link buildSplitUrl}) and the
 * in-window split never clobber each other, and a fresh unrelated tab restores
 * nothing. It still survives a refresh of the same tab — the case this fixes.
 */
export function saveSplitSessions(sessions: readonly string[]): void {
  const ids = Array.from(new Set(sessions.filter(Boolean))).slice(
    0,
    MAX_SPLIT_PANES,
  );
  try {
    sessionStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(ids));
    sessionStorage.setItem(SPLIT_OWNER_KEY, splitOwner());
  } catch {
    // Private mode / quota / SSR — persistence is best-effort.
  }
}

/**
 * The persisted split session set, or `[]` when absent/unavailable/malformed —
 * and when it was saved for a different daemon target than the live one.
 */
export function loadSplitSessions(): string[] {
  try {
    if (sessionStorage.getItem(SPLIT_OWNER_KEY) !== splitOwner()) return [];
    const raw = sessionStorage.getItem(SPLIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ).slice(0, MAX_SPLIT_PANES);
  } catch {
    return [];
  }
}

/** Forget the persisted split (e.g. when the user leaves the split view). */
export function clearSplitSessions(): void {
  try {
    sessionStorage.removeItem(SPLIT_STORAGE_KEY);
    sessionStorage.removeItem(SPLIT_OWNER_KEY);
  } catch {
    // best-effort
  }
}
