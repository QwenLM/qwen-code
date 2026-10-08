/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The structural half of the serve side's `LedgerSweepUnprovenError`: the
 * acp-integration boundary forbids importing from `serve/`, so any side
 * that only needs to READ a quarantine reason's ledger names and outstanding
 * group counts judges the shape instead of the class. The serve module
 * stays the producer's canonical definition.
 */
export interface UnprovenSweepReport {
  readonly workFile: string;
  readonly remaining: readonly unknown[];
}

/** Whether an arbitrary failure carries the structural sweep-report shape. */
export function isUnprovenSweepReport(
  failure: unknown,
): failure is UnprovenSweepReport {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    typeof (failure as { workFile?: unknown }).workFile === 'string' &&
    Array.isArray((failure as { remaining?: unknown }).remaining)
  );
}
