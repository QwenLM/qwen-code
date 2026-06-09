/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { searchTranscripts } from '../search/transcripts.js';

/** Route-facing kind values; 'tool' maps to record type tool_result downstream. */
const VALID_KINDS = ['user', 'assistant', 'tool', 'all'] as const;

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
): RequestHandler {
  return async (req, res) => {
    const rawQ = req.query.q;
    const q = typeof rawQ === 'string' ? rawQ.trim() : '';
    if (!q) {
      res.status(400).json({ error: 'Invalid query', code: 'invalid_query' });
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

    const hits = await searchTranscripts(dir, q, { kind, sessionId, limit });

    void audit?.record({
      action: 'search_performed',
      actorTokenId: req.rcClient?.id,
      // Privacy: count + kind only — never the query text.
      detail: { kind, resultCount: hits.length },
    });

    res.status(200).json({ hits });
  };
}
