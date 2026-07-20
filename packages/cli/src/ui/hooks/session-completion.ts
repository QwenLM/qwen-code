/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionService } from '@qwen-code/qwen-code-core';
import type { SessionListItem } from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { buildSessionRef } from './session-mention-ref.js';
import { t } from '../../i18n/index.js';

const MAX_SESSION_SUGGESTIONS = 20;

/**
 * Short TTL for the per-cwd session listing cache. Listing walks the chats dir
 * and does bounded reads per session file, so re-running it on every keystroke
 * adds visible input latency. A few seconds is short enough that a freshly
 * created/renamed session still appears promptly, while a burst of keystrokes
 * reuses one listing. Mirrors the intent of FileSearchFactory's `cacheTtl`.
 */
const SESSION_LIST_CACHE_TTL_MS = 3000;

interface CacheEntry {
  items: SessionListItem[];
  expiresAt: number;
}

// Cache the UNFILTERED listing keyed by cwd; pattern filtering is cheap and
// always applied fresh below.
const listingCache = new Map<string, CacheEntry>();

/** Test-only: clear the module-level listing cache between cases. */
export function __resetSessionSuggestionCacheForTest(): void {
  listingCache.clear();
}

async function listSessionsCached(
  cwd: string,
  nowMs: number,
): Promise<SessionListItem[]> {
  const cached = listingCache.get(cwd);
  if (cached && cached.expiresAt > nowMs) {
    return cached.items;
  }
  try {
    const res = await new SessionService(cwd).listSessions({
      size: MAX_SESSION_SUGGESTIONS,
    });
    listingCache.set(cwd, {
      items: res.items,
      expiresAt: nowMs + SESSION_LIST_CACHE_TTL_MS,
    });
    return res.items;
  } catch {
    // Listing failure: cache nothing so the next keystroke retries, and yield
    // an empty list so file/MCP/extension completion is never blocked.
    return [];
  }
}

/**
 * Lists prior sessions for the current project as `@` completion suggestions.
 * Scope is enforced by SessionService (current project only). The disk listing
 * is cached per cwd for a short TTL (see {@link SESSION_LIST_CACHE_TTL_MS}) so
 * rapid keystrokes don't re-walk the chats directory; pattern filtering runs
 * fresh on the cached items. A listing failure yields an empty list.
 *
 * @param nowMs Injected clock for the cache TTL (defaults to Date.now()).
 *   Exposed for deterministic tests.
 */
export async function getSessionSuggestions(
  cwd: string,
  pattern: string,
  nowMs: number = Date.now(),
): Promise<Suggestion[]> {
  const items = await listSessionsCached(cwd, nowMs);

  const needle = pattern.trim().toLowerCase();
  return items
    .map((s) => {
      const label = s.customTitle?.trim() || s.prompt || s.sessionId;
      const description = s.customTitle ? s.prompt : undefined;
      return {
        label,
        value: buildSessionRef(s.sessionId),
        description,
        sourceBadge: t('Session'),
        category: 'session' as const,
      } satisfies Suggestion;
    })
    .filter((sug) =>
      needle.length === 0
        ? true
        : `${sug.label} ${sug.description ?? ''}`
            .toLowerCase()
            .includes(needle),
    );
}
