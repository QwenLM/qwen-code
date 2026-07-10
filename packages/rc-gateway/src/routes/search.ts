/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER } from '../scopes.js';
import {
  searchTranscriptsDetailed,
  SearchTimeoutError,
  type SearchResult,
} from '../search/transcripts.js';

/** Route-facing kind values; 'tool' maps to record type tool_result downstream. */
const VALID_KINDS = ['user', 'assistant', 'tool', 'all'] as const;

/**
 * Opt-in BM25 ranked search (search slice 2). Returns ranked hits over the
 * prebuilt FTS5 index, or `null` when ranking is UNAVAILABLE (native dep absent,
 * no workspace, or an empty/never-built index) so the route transparently falls
 * back to the live scan. Injected (never statically imported here) so the route
 * module — and the gateway's static graph — never pulls in the native
 * better-sqlite3; the provider does the lazy dynamic import itself.
 */
export type RankedSearch = (
  q: string,
  opts: {
    kind?: string;
    sessionId?: string;
    lineage?: string;
    limit?: number;
    since?: number;
    until?: number;
    visibleSessionIds?: ReadonlySet<string>;
  },
) => Promise<SearchResult | null>;

/** Default per-query scan budget (spec.md: 2 s). config.toml knob deferred. */
const SEARCH_TIMEOUT_MS = 2000;

/**
 * GET /rc/search — full-text search over the workspace's on-disk JSONL session
 * transcripts. Mounted under requireScope(SESSION_READ); the per-caller
 * authorization is in-handler (cycle 76):
 *   - a session-locked SHARE token searches ONLY its locked session — sessionId
 *     is FORCED from req.rcClient.sessionLockId, NEVER read from ?sessionId (the
 *     cycle-18 cross-session leak class);
 *   - any other caller needs OWNER (in-handler) for an unrestricted search;
 *     a plain session:read token without a lock → 403.
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
  opts?: {
    timeoutMs?: number;
    now?: () => number;
    ranked?: RankedSearch;
    /**
     * Resolve the set of session ids visible to a given token id (for
     * non-owner callers). Returns undefined when the provider is absent (→ no
     * session-set restriction applied, which is the pre-cycle behavior).
     */
    visibleSessions?: (tokenId: string) => Promise<ReadonlySet<string>>;
  },
): RequestHandler {
  return async (req, res) => {
    // Authorization FIRST, before any query processing, so an unauthorized
    // caller learns nothing. A session-locked share is confined to its own
    // session (sessionId forced from the lock, server-side); everyone else
    // needs OWNER for an unrestricted search.
    const lock = req.rcClient?.sessionLockId;
    let sessionId: string | undefined;
    if (lock !== undefined) {
      // Defense-in-depth: a BLANK lock must never fall through to an unfiltered
      // full-workspace search (the scanner treats sessionId='' as "no filter").
      // Share creation rejects an empty sessionId so this is unreachable today,
      // but the handler must not depend on that external invariant — deny it.
      if (lock === '') {
        void audit?.record({
          action: 'scope_denied',
          actorTokenId: req.rcClient?.id,
          shareId: req.rcClient?.shareId,
          shareLabel: req.rcClient?.shareLabel,
          detail: { reason: 'invalid_session_lock' },
        });
        res
          .status(403)
          .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
        return;
      }
      sessionId = lock;
    } else {
      if (!req.rcClient?.scopes.includes(OWNER)) {
        void audit?.record({
          action: 'scope_denied',
          actorTokenId: req.rcClient?.id,
          shareId: req.rcClient?.shareId,
          shareLabel: req.rcClient?.shareLabel,
          detail: { required: OWNER },
        });
        res
          .status(403)
          .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
        return;
      }
      sessionId =
        typeof req.query.sessionId === 'string' && req.query.sessionId
          ? req.query.sessionId
          : undefined;
    }

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

    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, Math.trunc(parsedLimit)), 200)
      : 50;

    // Optional lineage filter: restrict to a session's fork lineage (ancestors +
    // descendants + self). The handler resolves the actual session set inline via
    // walkLineage; the route just reads the raw parameter and passes it through.
    const rawLineage = req.query.lineage;
    const lineage =
      typeof rawLineage === 'string' && rawLineage ? rawLineage : undefined;

    // Optional inclusive ISO-8601 time bounds (cycle 79). A present-but-
    // unparseable value is a 400 (mirrors invalid_kind); absent → no bound.
    const parseBound = (
      v: unknown,
    ): { ok: true; ms: number | undefined } | { ok: false } => {
      if (typeof v !== 'string' || v.length === 0)
        return { ok: true, ms: undefined };
      const ms = Date.parse(v);
      return Number.isNaN(ms) ? { ok: false } : { ok: true, ms };
    };
    const since = parseBound(req.query.since);
    if (!since.ok) {
      res.status(400).json({ error: 'Invalid since', code: 'invalid_since' });
      return;
    }
    const until = parseBound(req.query.until);
    if (!until.ok) {
      res.status(400).json({ error: 'Invalid until', code: 'invalid_until' });
      return;
    }

    // Opt-in BM25 ranked mode (search slice 2): ?rank=bm25. Effective `mode` in
    // the response reflects what actually RAN — a requested rank that is
    // unavailable transparently falls back to the scan and reports mode:'scan'.
    const wantRank = req.query.rank === 'bm25';

    const dir = await resolveDir();
    if (!dir) {
      // No workspace → empty result, but keep the 200 body shape uniform with
      // the scanned path (every 200 carries hits + truncated + elapsedMs + mode).
      res
        .status(200)
        .json({ hits: [], truncated: false, elapsedMs: 0, mode: 'scan' });
      return;
    }

    // The scan throws SearchTimeoutError only when the (route-supplied) budget
    // is exceeded → 503 search_timeout. The try/catch is REQUIRED here: server.ts
    // has no global error middleware, so an uncaught async throw would hang the
    // request. The timeout arg and this catch are added together, never split.
    // `elapsedMs` is measured at the route (pure arithmetic over a total clock);
    // the scanner's "clock never read unless a timeout is opted in" contract is
    // untouched. NOTE: this same `nowMs` is the scanner's deadline clock too, so
    // an injected constant `now` yields elapsedMs 0 (the scanner reads it).
    const nowMs = opts?.now ?? Date.now;
    const startedAt = nowMs();

    // BM25 ranked attempt (opt-in). Best-effort: a provider that returns null
    // (unavailable / empty index) or throws transparently falls back to the
    // scan below — ranked search must never turn an answerable query into an
    // error. NOTE: better-sqlite3 is synchronous, so a ranked query briefly
    // blocks the event loop; acceptable for the single-owner localhost gateway
    // (a worker-thread offload is the documented future path if a very large
    // index makes the block matter).
    let mode: 'scan' | 'bm25' = 'scan';
    let result: SearchResult | undefined;
    // Compute visible-session set for non-owner callers. An owner (or a
    // session-locked share which already forced sessionId above) gets
    // `undefined` (= no restriction). A non-owner non-share token gets a set
    // from `token_session_history`; the ranked search provider resolves it.
    // The scan path ignores this field (the scanner never crosses session
    // boundaries without an explicit sessionId filter anyway, and the scan is
    // a fallback-only path for the BM25 provider).
    const visibleSessionIds: ReadonlySet<string> | undefined =
      lock !== undefined
        ? // Share: already forced to one session via sessionId; no extra set needed
          undefined
        : req.rcClient?.scopes.includes(OWNER)
          ? // Owner: no restriction
            undefined
          : // Non-owner: pass visibility set (provider resolves from DB)
            opts?.visibleSessions
            ? await opts.visibleSessions(req.rcClient?.id ?? '')
            : undefined;

    if (wantRank && opts?.ranked) {
      try {
        const ranked = await opts.ranked(q, {
          kind,
          sessionId,
          lineage,
          limit,
          since: since.ms,
          until: until.ms,
          visibleSessionIds,
        });
        if (ranked) {
          result = ranked;
          mode = 'bm25';
        }
      } catch {
        // fall through to the live scan
      }
    }

    if (result === undefined) {
      try {
        result = await searchTranscriptsDetailed(dir, q, {
          kind,
          sessionId,
          lineage,
          limit,
          since: since.ms,
          until: until.ms,
          visibleSessionIds,
          timeoutMs: opts?.timeoutMs ?? SEARCH_TIMEOUT_MS,
          now: opts?.now,
        });
      } catch (err) {
        if (err instanceof SearchTimeoutError) {
          void audit?.record({
            action: 'search_performed',
            actorTokenId: req.rcClient?.id,
            shareId: req.rcClient?.shareId,
            shareLabel: req.rcClient?.shareLabel,
            // Privacy: kind + timeout flag only — never the query text or count.
            detail: {
              kind,
              timedOut: true,
              ...(lock !== undefined ? { sessionScoped: true } : {}),
            },
          });
          res
            .status(503)
            .json({ error: 'Search timed out', code: 'search_timeout' });
          return;
        }
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: 'Search failed', code: 'search_error' });
        }
        return;
      }
    }

    const elapsedMs = Math.max(0, Math.round(nowMs() - startedAt));

    void audit?.record({
      action: 'search_performed',
      actorTokenId: req.rcClient?.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      // Privacy: count + kind only — never the query text. timing is not audited.
      // `rank` is recorded ONLY on a successful bm25 run, so the scan path's
      // detail stays byte-identical to before.
      detail: {
        kind,
        resultCount: result.hits.length,
        ...(mode === 'bm25' ? { rank: 'bm25' } : {}),
        ...(lock !== undefined ? { sessionScoped: true } : {}),
      },
    });

    res.status(200).json({
      hits: result.hits,
      truncated: result.truncated,
      elapsedMs,
      mode,
    });
  };
}
