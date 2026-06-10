/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import {
  searchTranscripts,
  SearchTimeoutError,
} from '../search/transcripts.js';

/** Route-facing kind values; 'tool' maps to record type tool_result downstream. */
const VALID_KINDS = ['user', 'assistant', 'tool', 'all'] as const;

/** Default per-query scan budget (spec.md: 2 s). config.toml knob deferred. */
const SEARCH_TIMEOUT_MS = 2000;

/**
 * GET /rc/search — owner-only full-text search over the workspace's on-disk
 * JSONL session transcripts. Owner-gating is applied at the mount site
 * (requireScope(OWNER)), so no in-handler scope check is needed.
 *
 * `resolveDir` yields the chats dir for the current workspace (or undefined
 * when there is no workspace / the daemon errored → 200 {hits:[]}). The audit
 * entry carries ONLY { kind, resultCount } — NEVER the query text, which may
 * contain sensitive terms. No filesystem path is ever built from q/kind/
 * sessionId.
 */
export function createSearchRoute(
  resolveDir: () => Promise<string | undefined>,
  audit?: AuditRecorder,
  opts?: { timeoutMs?: number; now?: () => number },
): RequestHandler {
  return async (req, res) => {
    const rawQ = req.query.q;
    const q = typeof rawQ === 'string' ? rawQ.trim() : '';
    if (!q) {
      res.status(400).json({ error: 'Invalid query', code: 'invalid_query' });
      return;
    }
    // Bounds parse/tree cost (the per-query scan timeout is a separate, still
    // deferred guard). 1024 chars per the design's threat table. NOTE: this cap
    // ALSO bounds parser recursion depth — `parseQuery` recurses ~3 frames per
    // `(`, and V8 overflows the stack at ~2124 nested parens, so 1024 chars
    // keeps a ~2x safety margin. Do NOT raise this above ~2000 without first
    // making the parser iterative or adding a depth guard in query.ts.
    if (q.length > 1024) {
      res.status(400).json({ error: 'Query too long', code: 'query_too_long' });
      return;
    }

    const rawKind = req.query.kind;
    const kind = typeof rawKind === 'string' && rawKind ? rawKind : 'all';
    if (!(VALID_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ error: 'Invalid kind', code: 'invalid_kind' });
      return;
    }

    const sessionId =
      typeof req.query.sessionId === 'string' && req.query.sessionId
        ? req.query.sessionId
        : undefined;

    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, Math.trunc(parsedLimit)), 200)
      : 50;

    const dir = await resolveDir();
    if (!dir) {
      res.status(200).json({ hits: [] });
      return;
    }

    // The scan throws SearchTimeoutError only when the (route-supplied) budget
    // is exceeded → 503 search_timeout. The try/catch is REQUIRED here: server.ts
    // has no global error middleware, so an uncaught async throw would hang the
    // request. The timeout arg and this catch are added together, never split.
    let hits;
    try {
      hits = await searchTranscripts(dir, q, {
        kind,
        sessionId,
        limit,
        timeoutMs: opts?.timeoutMs ?? SEARCH_TIMEOUT_MS,
        now: opts?.now,
      });
    } catch (err) {
      if (err instanceof SearchTimeoutError) {
        void audit?.record({
          action: 'search_performed',
          actorTokenId: req.rcClient?.id,
          // Privacy: kind + timeout flag only — never the query text or a count.
          detail: { kind, timedOut: true },
        });
        res
          .status(503)
          .json({ error: 'Search timed out', code: 'search_timeout' });
        return;
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Search failed', code: 'search_error' });
      }
      return;
    }

    void audit?.record({
      action: 'search_performed',
      actorTokenId: req.rcClient?.id,
      // Privacy: count + kind only — never the query text.
      detail: { kind, resultCount: hits.length },
    });

    res.status(200).json({ hits });
  };
}
