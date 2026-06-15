/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure query helpers for the `/rc/usage` endpoint and the `qwen-rc usage` CLI
 * (`add-cost-tracking`: "/rc/usage aggregation" + "Scope filtering" + "Operator
 * CLI"). Time-window parsing, CSV rendering, group-by validation, and the
 * scope→attribution-filter rule live here so they are unit-tested without a
 * route, a store, or the native sqlite dep.
 */

import { OWNER, type RcScope } from '../scopes.js';
import type { GroupBy } from './usageStore.js';

export const USAGE_GROUP_BYS: readonly GroupBy[] = [
  'session',
  'client',
  'sub_actor',
  'model',
];

const RELATIVE_RE = /^(\d+)([smhd])$/;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `since`/`until` value: a relative duration (`24h`, `7d`, `30m`, `45s`)
 * is subtracted from `nowMs`; an ISO-8601 string is parsed absolutely. Throws on
 * an unparseable value (the route maps that to 400).
 */
export function parseSince(value: string, nowMs: number): number {
  const rel = RELATIVE_RE.exec(value.trim());
  if (rel) return nowMs - Number(rel[1]) * UNIT_MS[rel[2]];
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new Error(`invalid time value: ${value}`);
  }
  return t;
}

/** Parse `until` (ISO-8601 or relative); defaults to `nowMs` when absent. */
export function parseUntil(value: string | undefined, nowMs: number): number {
  if (value === undefined || value === '') return nowMs;
  return parseSince(value, nowMs);
}

/** Validate a `group_by` query value. */
export function parseGroupBy(value: string | undefined): GroupBy | null {
  return USAGE_GROUP_BYS.includes(value as GroupBy) ? (value as GroupBy) : null;
}

/**
 * The attribution-token filter to apply for a caller: owner sees ALL rows
 * (undefined = no filter); every lesser scope sees only rows attributed to its
 * own token id. Bridge sub-actors are preserved in the response regardless (the
 * store always returns `sub_actor`).
 */
export function usageAttributionFilter(client: {
  id: string;
  scopes: RcScope[];
}): string | undefined {
  return client.scopes.includes(OWNER) ? undefined : client.id;
}

/** A response row (store aggregate row + a human display label). */
export interface UsageResponseRow {
  key: string;
  displayLabel: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costCents: number;
}

export const USAGE_CSV_HEADER =
  'key,displayLabel,tokensIn,tokensOut,tokensCached,costCents';

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render aggregate rows as CSV with the spec's exact header. */
export function formatUsageCsv(rows: UsageResponseRow[]): string {
  const lines = [USAGE_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.key),
        csvCell(r.displayLabel),
        csvCell(r.tokensIn),
        csvCell(r.tokensOut),
        csvCell(r.tokensCached),
        csvCell(r.costCents),
      ].join(','),
    );
  }
  return lines.join('\n');
}
