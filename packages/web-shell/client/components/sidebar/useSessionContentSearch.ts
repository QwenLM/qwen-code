/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { DaemonClient, DaemonSessionSummary } from '@qwen-code/sdk/daemon';

export interface SessionContentSearchHit {
  session: DaemonSessionSummary;
  snippet: string;
}

const EMPTY_HITS: ReadonlyMap<string, SessionContentSearchHit> = new Map();

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * Debounced conversation-content search behind the sidebar session search
 * box. Local title/id/git matching stays the client-side fast path; this
 * hook asks the daemon to scan persisted transcripts and returns the hits —
 * including sessions not yet loaded into the catalog, with a snippet of the
 * matched message — keyed by session id in server (recency) order. Any
 * request failure (including a 404 from a daemon too old to serve the
 * route) degrades to local-only filtering.
 */
export function useSessionContentSearch(
  client: DaemonClient | undefined,
  workspaceCwd: string | undefined,
  query: string,
): ReadonlyMap<string, SessionContentSearchHit> {
  const [hits, setHits] =
    useState<ReadonlyMap<string, SessionContentSearchHit>>(EMPTY_HITS);

  useEffect(() => {
    const trimmed = query.trim();
    if (
      !client ||
      !workspaceCwd ||
      trimmed.length < MIN_QUERY_LENGTH ||
      typeof client.searchWorkspaceSessions !== 'function'
    ) {
      setHits(EMPTY_HITS);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client
        .searchWorkspaceSessions(workspaceCwd, trimmed, {
          signal: controller.signal,
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          setHits(
            new Map(
              result.results.map((match) => [match.session.sessionId, match]),
            ),
          );
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setHits(EMPTY_HITS);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceCwd, query]);

  return hits;
}
