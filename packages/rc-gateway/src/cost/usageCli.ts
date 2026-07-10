/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parsing + rendering for the `qwen-rc usage` / `usage prune` operator CLI
 * (`add-cost-tracking`: "Operator CLI"). The daemon-free CLI glue in cli.ts opens
 * the usage store and calls these — kept pure so flag parsing and the table
 * renderer are unit-tested without a store.
 */

import {
  parseSince,
  parseGroupBy,
  type UsageResponseRow,
} from './usageQuery.js';
import type { GroupBy } from './usageStore.js';

export interface UsageQueryArgs {
  sinceMs: number;
  groupBy: GroupBy;
  subActor?: string;
  format: 'json' | 'csv' | 'table';
}

export interface PruneArgs {
  beforeMs: number;
  yes: boolean;
}

/** A `--flag=value` / `--flag value` reader over an argv slice. */
function readFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * Parse `usage [--since <d>] [--group-by <axis>] [--sub-actor <s>] [--format
 * json|csv|table]`. `now` resolves relative `--since`. Throws on a bad value.
 */
export function parseUsageArgs(argv: string[], now: number): UsageQueryArgs {
  const sinceMs = parseSince(readFlag(argv, 'since') ?? '24h', now);
  const groupBy = parseGroupBy(readFlag(argv, 'group-by') ?? 'session');
  if (!groupBy) {
    throw new Error('--group-by must be session|client|sub_actor|model');
  }
  const format = readFlag(argv, 'format') ?? 'table';
  if (format !== 'json' && format !== 'csv' && format !== 'table') {
    throw new Error('--format must be json|csv|table');
  }
  return {
    sinceMs,
    groupBy,
    subActor: readFlag(argv, 'sub-actor'),
    format,
  };
}

/** Parse `usage prune --before <iso> [--yes]`. Throws if `--before` is missing/bad. */
export function parsePruneArgs(argv: string[]): PruneArgs {
  const before = readFlag(argv, 'before');
  if (!before) throw new Error('usage prune requires --before <iso-8601>');
  const beforeMs = Date.parse(before);
  if (Number.isNaN(beforeMs)) {
    throw new Error(`invalid --before timestamp: ${before}`);
  }
  return { beforeMs, yes: hasFlag(argv, 'yes') };
}

/** Render rows as an aligned text table (the CLI default `--format table`). */
export function formatUsageTable(
  rows: UsageResponseRow[],
  currencyLabel: string,
): string {
  const header = [
    'KEY',
    'LABEL',
    'IN',
    'OUT',
    'CACHED',
    `COST(${currencyLabel}¢)`,
  ];
  const body = rows.map((r) => [
    r.key,
    r.displayLabel,
    String(r.tokensIn),
    String(r.tokensOut),
    String(r.tokensCached),
    r.costCents.toFixed(2),
  ]);
  // Note: costCents is derived from costMicrocents at presentation time in the route.
  const widths = header.map((h, c) =>
    Math.max(h.length, ...body.map((row) => row[c].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => cell.padEnd(widths[c]))
      .join('  ')
      .trimEnd();
  if (rows.length === 0) return `${line(header)}\n(no usage in window)`;
  return [line(header), ...body.map(line)].join('\n');
}
