/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  outputSpeed,
  summarizeSessionUsage,
} from '../artifacts/tokenUsageTotals';
import { diagnosticStats } from './managed-diagnostics.test-fixtures';
import { managedDiagnosticStatsToUsageSnapshot } from './managed-usage-stats';

describe('managedDiagnosticStatsToUsageSnapshot', () => {
  it('projects available and partial ManagedDiagnosticStats totals onto the shared usage snapshot', () => {
    for (const availability of ['available', 'partial'] as const) {
      const snapshot = managedDiagnosticStatsToUsageSnapshot({
        ...diagnosticStats,
        availability,
      });
      expect(snapshot.sessionId).toBe('s1');
      expect(snapshot.promptCount).toBe(0);
      expect(snapshot.cacheHitUnknown).toBe(false);

      const totals = summarizeSessionUsage(snapshot);
      expect(totals.total).toBe(110);
      expect(totals.prompt).toBe(100);
      expect(totals.cached).toBe(20);
      expect(totals.output).toBe(10);
      expect(totals.requests).toBe(1);
      expect(totals.legacySpeed).toBe(true);
      expect(outputSpeed(totals.generation, totals.legacySpeed)).toBeCloseTo(
        (10 * 1000) / 900,
        5,
      );
    }
  });

  it('reads statistics.totals even when per-model breakdown is omitted or overflowed', () => {
    const snapshot = managedDiagnosticStatsToUsageSnapshot({
      ...diagnosticStats,
      statistics: {
        ...diagnosticStats.statistics!,
        models: [],
        modelBreakdownOmitted: true,
      },
    });
    expect(summarizeSessionUsage(snapshot).total).toBe(110);
  });

  it('marks cacheHitUnknown and zeroes cached when no request reported cached usage', () => {
    const base = diagnosticStats.statistics!;
    const snapshot = managedDiagnosticStatsToUsageSnapshot({
      ...diagnosticStats,
      statistics: {
        ...base,
        totals: {
          ...base.totals,
          tokens: { ...base.totals.tokens, cached: 50 },
          usageKnown: { ...base.totals.usageKnown, cached: 0 },
        },
      },
    });
    expect(snapshot.cacheHitUnknown).toBe(true);
    const totals = summarizeSessionUsage(snapshot);
    expect(totals.cached).toBe(0);
    expect(totals.total).toBe(110);
  });

  it.each([
    {
      label: 'unsupported availability',
      stats: { ...diagnosticStats, availability: 'unsupported' as const },
    },
    {
      label: 'not_recorded availability',
      stats: { ...diagnosticStats, availability: 'not_recorded' as const },
    },
    {
      label: 'null statistics',
      stats: { ...diagnosticStats, statistics: null },
    },
    {
      label: 'zero requests',
      stats: {
        ...diagnosticStats,
        statistics: {
          ...diagnosticStats.statistics!,
          totals: {
            ...diagnosticStats.statistics!.totals,
            requests: {
              total: 0,
              success: 0,
              error: 0,
              cancelled: 0,
              interrupted: 0,
            },
          },
        },
      },
    },
    {
      label: 'no known token counts',
      stats: {
        ...diagnosticStats,
        statistics: {
          ...diagnosticStats.statistics!,
          totals: {
            ...diagnosticStats.statistics!.totals,
            usageKnown: {
              prompt: 0,
              candidates: 0,
              total: 0,
              cached: 0,
              thoughts: 0,
            },
          },
        },
      },
    },
  ])('fails closed with empty models on $label', ({ stats }) => {
    const snapshot = managedDiagnosticStatsToUsageSnapshot(stats);
    expect(snapshot.sessionId).toBe('s1');
    expect(snapshot.promptCount).toBe(0);
    expect(snapshot.models).toEqual({});
    expect(summarizeSessionUsage(snapshot).total).toBe(0);
  });
});
