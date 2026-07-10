/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQLite-backed `usage_events` store for cost tracking (`add-cost-tracking`:
 * "Ingest priced rows" + "/rc/usage aggregation" + the `prune` CLI). One row per
 * usage-bearing `session_update`, attributed to the originating client token (and
 * a bridge sub-actor when present). Indexed for the common group-by windows.
 *
 * Like {@link SearchIndex}, this is a NATIVE `better-sqlite3` consumer; the daemon
 * loads it dynamically so a missing native build disables cost tracking rather
 * than breaking the gateway (mirrors the search-index isolation). A NULL
 * `cost_microcents` records an unpriced (rate-table-miss) row — visibly unpriced.
 *
 * Costs are stored as INTEGER microcents (1 cent = 1 000 000 microcents) to avoid
 * floating-point accumulation errors and allow exact integer arithmetic at write
 * time. Presentation-layer helpers in {@link usageQuery} convert back to cents.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** A row to insert. `costMicrocents` is null on a rate-table miss. `ts` is unix ms. */
export interface UsageRowInput {
  sessionId: string;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Cost in microcents (1 cent = 1 000 000 microcents), or null on miss. */
  costMicrocents: number | null;
  modelServiceId: string;
  modelId: string;
  attributionTokenId: string;
  subActor: string | null;
  stage: string | null;
}

/** Running totals for a session (the `usage_tick` payload's source). */
export interface SessionTotals {
  /** Sum of cost in microcents (NULL rows count as 0). */
  costMicrocentsSesTotal: number;
  tokensInTotal: number;
  tokensOutTotal: number;
  tokensCachedTotal: number;
}

export type GroupBy = 'session' | 'client' | 'sub_actor' | 'model';

export interface AggregateQuery {
  sinceMs: number;
  untilMs: number;
  groupBy: GroupBy;
  /** When set, only rows with this attribution token id (scope filtering). */
  attributionTokenId?: string;
  /** When set, only rows with this exact sub_actor (the CLI `--sub-actor`). */
  subActor?: string;
}

export interface AggregateRow {
  key: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Sum of cost in microcents for this group. */
  costMicrocents: number;
}

const GROUP_COLUMN: Record<GroupBy, string> = {
  session: 'session_id',
  client: 'attribution_token_id',
  sub_actor: 'sub_actor',
  model: "model_service_id || '/' || model_id",
};

export class UsageStore {
  private constructor(private readonly db: Database.Database) {}

  /** Open (creating if needed) the usage db; dir 0700, file 0600. */
  static open(dbPath: string): UsageStore {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    const db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS usage_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id TEXT NOT NULL,
         ts INTEGER NOT NULL,
         tokens_in INTEGER NOT NULL,
         tokens_out INTEGER NOT NULL,
         tokens_cached INTEGER NOT NULL,
         cost_microcents INTEGER,
         model_service_id TEXT NOT NULL,
         model_id TEXT NOT NULL,
         attribution_token_id TEXT NOT NULL,
         sub_actor TEXT,
         stage TEXT
       )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events (session_id, ts)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_usage_attr ON usage_events (attribution_token_id, ts)`,
    );
    return new UsageStore(db);
  }

  /** Insert one usage row. */
  record(row: UsageRowInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
           session_id, ts, tokens_in, tokens_out, tokens_cached, cost_microcents,
           model_service_id, model_id, attribution_token_id, sub_actor, stage
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sessionId,
        row.ts,
        row.tokensIn,
        row.tokensOut,
        row.tokensCached,
        row.costMicrocents !== null ? Math.round(row.costMicrocents) : null,
        row.modelServiceId,
        row.modelId,
        row.attributionTokenId,
        row.subActor,
        row.stage,
      );
  }

  /** Cumulative totals for a session (NULL costs count as 0). */
  sessionTotals(sessionId: string): SessionTotals {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_microcents), 0) AS cost,
           COALESCE(SUM(tokens_in), 0) AS tin,
           COALESCE(SUM(tokens_out), 0) AS tout,
           COALESCE(SUM(tokens_cached), 0) AS tcached
         FROM usage_events WHERE session_id = ?`,
      )
      .get(sessionId) as {
      cost: number;
      tin: number;
      tout: number;
      tcached: number;
    };
    return {
      costMicrocentsSesTotal: r.cost,
      tokensInTotal: r.tin,
      tokensOutTotal: r.tout,
      tokensCachedTotal: r.tcached,
    };
  }

  /**
   * Aggregate priced rows in `[sinceMs, untilMs]` grouped by `groupBy`. A NULL
   * `sub_actor` groups under the empty key when grouping by sub_actor. Rows are
   * ordered by descending cost so the highest-cost keys come first.
   */
  aggregate(q: AggregateQuery): AggregateRow[] {
    const col = GROUP_COLUMN[q.groupBy];
    const params: unknown[] = [q.sinceMs, q.untilMs];
    let where = 'ts >= ? AND ts <= ?';
    if (q.attributionTokenId !== undefined) {
      where += ' AND attribution_token_id = ?';
      params.push(q.attributionTokenId);
    }
    if (q.subActor !== undefined) {
      where += ' AND sub_actor = ?';
      params.push(q.subActor);
    }
    const rows = this.db
      .prepare(
        `SELECT
           ${col} AS key,
           COALESCE(SUM(tokens_in), 0) AS tin,
           COALESCE(SUM(tokens_out), 0) AS tout,
           COALESCE(SUM(tokens_cached), 0) AS tcached,
           COALESCE(SUM(cost_microcents), 0) AS cost
         FROM usage_events
         WHERE ${where}
         GROUP BY ${col}
         ORDER BY cost DESC`,
      )
      .all(...params) as Array<{
      key: string | null;
      tin: number;
      tout: number;
      tcached: number;
      cost: number;
    }>;
    return rows.map((r) => ({
      key: r.key ?? '',
      tokensIn: r.tin,
      tokensOut: r.tout,
      tokensCached: r.tcached,
      costMicrocents: r.cost,
    }));
  }

  /** Delete rows with `ts < beforeMs`; returns the number removed. */
  prune(beforeMs: number): number {
    const info = this.db
      .prepare(`DELETE FROM usage_events WHERE ts < ?`)
      .run(beforeMs);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
