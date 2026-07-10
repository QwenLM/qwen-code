/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AggregateQuery, AggregateRow } from '../cost/usageStore.js';
import {
  parseSince,
  parseUntil,
  parseGroupBy,
  usageAttributionFilter,
  formatUsageCsv,
  computeEfficiency,
  type UsageResponseRow,
} from '../cost/usageQuery.js';

/** The read surface the route needs (the real {@link UsageStore} satisfies it). */
export interface UsageReader {
  aggregate(q: AggregateQuery): AggregateRow[];
}

export interface UsageRouteDeps {
  store: UsageReader;
  /** Wall clock (injectable for tests). */
  now: () => number;
  /**
   * Map an aggregate key to a human label (e.g. a client tokenId → its name).
   * Defaults to the key itself. The wiring passes a token-store-backed labeler.
   */
  labelFor?: (groupBy: AggregateQuery['groupBy'], key: string) => string;
}

/**
 * GET /rc/usage?since=&until=&group_by=&format= — aggregated usage rows.
 *
 * Scope filtering (spec): an `owner` token sees all rows; every lesser scope
 * (write/approve/read/bridge) sees only rows attributed to its own token id. The
 * filter is derived from the resolved `rcClient`, never a query param, so a caller
 * cannot widen its own view. `format=csv` returns `text/csv` with the spec header;
 * default is JSON `{ rows }`.
 *
 * Each response row includes `costMicrocents` (raw integer from the store),
 * `costCents` (derived presentation float), and `efficiency` metrics computed at
 * presentation time so the store stays free of floating-point values.
 */
export function createUsageRoute(deps: UsageRouteDeps): RequestHandler {
  return (req, res) => {
    const client = req.rcClient;
    if (!client) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }

    const q = req.query as Record<string, string | undefined>;
    const now = deps.now();

    const groupBy = parseGroupBy(q['group_by'] ?? 'session');
    if (!groupBy) {
      res.status(400).json({
        error: 'invalid group_by (session|client|sub_actor|model)',
        code: 'invalid_group_by',
      });
      return;
    }

    const format = q['format'] ?? 'json';
    if (format !== 'json' && format !== 'csv') {
      res
        .status(400)
        .json({ error: 'invalid format (json|csv)', code: 'invalid_format' });
      return;
    }

    let sinceMs: number;
    let untilMs: number;
    try {
      sinceMs = parseSince(q['since'] ?? '24h', now);
      untilMs = parseUntil(q['until'], now);
    } catch {
      res
        .status(400)
        .json({ error: 'invalid since/until', code: 'invalid_time' });
      return;
    }

    const rows = deps.store.aggregate({
      sinceMs,
      untilMs,
      groupBy,
      attributionTokenId: usageAttributionFilter(client),
    });

    const label = deps.labelFor ?? ((_g, key) => key);
    const MICRO = 1_000_000;
    const out: UsageResponseRow[] = rows.map((r) => {
      const costCents = r.costMicrocents / MICRO;
      return {
        key: r.key,
        displayLabel: label(groupBy, r.key),
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        tokensCached: r.tokensCached,
        costMicrocents: r.costMicrocents,
        costCents,
        efficiency: computeEfficiency(r.costMicrocents, r.tokensOut),
      };
    });

    if (format === 'csv') {
      res.status(200).type('text/csv').send(formatUsageCsv(out));
      return;
    }
    res.status(200).json({ rows: out });
  };
}
