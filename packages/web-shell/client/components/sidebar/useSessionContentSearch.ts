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
/** Matches the daemon route's `q` limit; over-long pastes search their prefix. */
const MAX_QUERY_LENGTH = 200;

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
  // Normalize at render scope: the effect depends on this value, so
  // whitespace-only edits neither blank hits nor re-fetch. The cap drops a
  // lead surrogate straddling the boundary instead of slicing mid-pair.
  let trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
  const lastUnit = trimmed.charCodeAt(trimmed.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    trimmed = trimmed.slice(0, -1);
  }

  const [state, setState] = useState<{
    client: DaemonClient | undefined;
    workspaceCwd: string | undefined;
    trimmed: string;
    hits: ReadonlyMap<string, SessionContentSearchHit>;
  }>({ client, workspaceCwd, trimmed, hits: EMPTY_HITS });

  // Reset during render, not in the passive effect (which runs after
  // paint): the first committed render after a query/workspace/client
  // change must not pair the new key with the previous key's settled hits.
  if (
    state.client !== client ||
    state.workspaceCwd !== workspaceCwd ||
    state.trimmed !== trimmed
  ) {
    setState({ client, workspaceCwd, trimmed, hits: EMPTY_HITS });
  }

  useEffect(() => {
    if (
      !client ||
      !workspaceCwd ||
      trimmed.length < MIN_QUERY_LENGTH ||
      typeof client.searchWorkspaceSessions !== 'function'
    ) {
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
          setState({
            client,
            workspaceCwd,
            trimmed,
            hits: new Map(
              result.results.map((match) => [match.session.sessionId, match]),
            ),
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setState({ client, workspaceCwd, trimmed, hits: EMPTY_HITS });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceCwd, trimmed]);

  return state.client === client &&
    state.workspaceCwd === workspaceCwd &&
    state.trimmed === trimmed
    ? state.hits
    : EMPTY_HITS;
}
