/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addModelStatisticsGap,
  boundManagedModelStatistics,
  createManagedModelStatistics,
  parseManagedStatisticsEnvelope,
  recordManagedModelObservation,
} from './managed-model-statistics.js';
import type { ModelInvocationObservation } from '../telemetry/model-observation.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-model-statistics-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  valid: Array<{ name: string; kind: string; body: unknown }>;
  invalid: Array<{ name: string; kind: string; body: unknown }>;
};

const observation = (
  fields: Partial<ModelInvocationObservation> = {},
): ModelInvocationObservation => ({
  executionId: randomUUID(),
  source: 'main',
  model: 'qwen-test',
  at: 10,
  outcome: 'success',
  durationMs: 200,
  failureKind: null,
  statusCode: null,
  backoffRetryOrdinal: 0,
  ...fields,
});

describe('bounded Managed model statistics', () => {
  it.each(fixtures.valid)('accepts shared $name', ({ kind, body }) => {
    expect(parseManagedStatisticsEnvelope(kind, body)).toEqual(body);
  });
  it.each(fixtures.invalid)('rejects shared $name', ({ kind, body }) => {
    expect(() => parseManagedStatisticsEnvelope(kind, body)).toThrow();
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid raw budget values %s',
    (value) => {
      const statistics = createManagedModelStatistics();
      statistics.snapshotRevision = 1;
      const budget = {
        sessionId: 'session-1',
        promptId: 'turn-1',
        budget: 5000,
        outputTokensAtTurnStart: 0,
      };
      const body = { version: 1, statistics, budget, context: null };
      statistics.rawOutputTokensTotal = value;
      expect(() =>
        parseManagedStatisticsEnvelope('managed-session-model-stats', body),
      ).toThrow('rawOutputTokensTotal');
      statistics.rawOutputTokensTotal = 0;
      budget.outputTokensAtTurnStart = value;
      expect(() =>
        parseManagedStatisticsEnvelope('managed-session-model-stats', body),
      ).toThrow('outputTokensAtTurnStart');
    },
  );

  it('keeps normalized counters and revisions integral with fractional raw usage', () => {
    const statistics = createManagedModelStatistics();
    statistics.snapshotRevision = 1;
    statistics.rawOutputTokensTotal = 38.25;
    const body = { version: 1, statistics, budget: null, context: null };
    statistics.totals.tokens.candidates = 11.25;
    expect(() =>
      parseManagedStatisticsEnvelope('managed-session-model-stats', body),
    ).toThrow('tokens.candidates');
    statistics.totals.tokens.candidates = 0;
    statistics.snapshotRevision = 1.5;
    expect(() =>
      parseManagedStatisticsEnvelope('managed-session-model-stats', body),
    ).toThrow('snapshotRevision');
  });

  it('counts invocations independently of business parsing, and preserves unknown token fields', () => {
    const statistics = createManagedModelStatistics();
    recordManagedModelObservation(
      statistics,
      observation({
        source: 'hook',
        usage: { promptTokenCount: 10, candidatesTokenCount: 4 },
        ttftMs: 20,
        generationMs: 120,
      }),
    );
    recordManagedModelObservation(
      statistics,
      observation({
        source: 'compression',
        outcome: 'error',
        failureKind: 'http',
        statusCode: 429,
        backoffRetryOrdinal: 2,
      }),
    );
    expect(statistics.totals.requests).toEqual({
      total: 2,
      success: 1,
      error: 1,
      cancelled: 0,
      interrupted: 0,
    });
    expect(statistics.sources.hook.requests.success).toBe(1);
    expect(statistics.sources.compression.backoffRetries).toBe(1);
    expect(statistics.totals.usageKnown).toEqual({
      prompt: 1,
      candidates: 1,
      total: 1,
      cached: 0,
      thoughts: 0,
    });
    expect(statistics.totals.tokens.total).toBe(14);
    expect(statistics.totals.timing.throughputOutputTokens).toBe(4);
    expect(statistics.coverage.gaps).toContain('missing_usage');
  });

  it('keeps 16 model buckets, one overflow and 20 samples over a long session', () => {
    const statistics = createManagedModelStatistics();
    for (let i = 0; i < 1000; i++)
      recordManagedModelObservation(
        statistics,
        observation({ model: `model-${i}` + '界'.repeat(200), at: i }),
      );
    const bounded = boundManagedModelStatistics(statistics);
    expect(bounded.models).toHaveLength(16);
    expect(
      bounded.models.every((model) => Buffer.byteLength(model.name!) <= 128),
    ).toBe(true);
    expect(bounded.overflow.requests.total).toBe(984);
    expect(bounded.recent).toHaveLength(20);
    expect(bounded.samplesTruncated).toBe(true);
    expect(bounded.totals.requests.total).toBe(1000);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      40 * 1024,
    );
  });

  it.each([
    { authType: 'gemini-api-key', candidates: 10, expected: 30 },
    { authType: 'openai', candidates: 30, expected: 30 },
  ])(
    'counts reasoning once for $authType without changing raw budget counters',
    ({ authType, candidates, expected }) => {
      const statistics = createManagedModelStatistics();
      recordManagedModelObservation(
        statistics,
        observation({
          authType,
          usage: {
            promptTokenCount: 100,
            candidatesTokenCount: candidates,
            thoughtsTokenCount: 20,
            totalTokenCount: 130,
          },
          generationMs: 200,
        }),
      );
      expect(statistics.totals.tokens.candidates).toBe(expected);
      expect(statistics.totals.tokens.total).toBe(130);
      expect(statistics.recent[0].outputTokens).toBe(expected);
      expect(statistics.totals.timing.throughputOutputTokens).toBe(expected);
      expect(statistics.rawOutputTokensTotal).toBe(0);
      expect(statistics.totals.usageKnown.cached).toBe(0);
    },
  );

  it('keeps missing output unknown when only total and reasoning are reported', () => {
    const statistics = createManagedModelStatistics();
    recordManagedModelObservation(
      statistics,
      observation({
        usage: {
          totalTokenCount: 130,
          promptTokenCount: 100,
          thoughtsTokenCount: 20,
        },
      }),
    );
    expect(statistics.totals.usageKnown.candidates).toBe(0);
    expect(statistics.recent[0].outputTokens).toBeNull();
  });

  it('does not turn cached input into a known complete prompt count', () => {
    const statistics = createManagedModelStatistics();
    recordManagedModelObservation(
      statistics,
      observation({
        usage: {
          cachedContentTokenCount: 100,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 0,
        },
      }),
    );
    expect(statistics.totals.usageKnown.prompt).toBe(0);
    expect(statistics.totals.usageKnown.total).toBe(0);
    expect(statistics.totals.tokens.prompt).toBe(0);
    expect(statistics.totals.tokens.cached).toBe(100);
  });

  it('retains gaps and aggregate counters under overflow and bounded degradation', () => {
    const statistics = createManagedModelStatistics();
    addModelStatisticsGap(statistics, 'unclosed_turn');
    for (let i = 0; i < 16; i++)
      recordManagedModelObservation(
        statistics,
        observation({
          model: '界'.repeat(100) + i,
          durationMs: Number.MAX_SAFE_INTEGER,
          usage: {
            promptTokenCount: Number.MAX_SAFE_INTEGER,
            candidatesTokenCount: Number.MAX_SAFE_INTEGER,
            cachedContentTokenCount: Number.MAX_SAFE_INTEGER,
            thoughtsTokenCount: Number.MAX_SAFE_INTEGER,
          },
        }),
      );
    recordManagedModelObservation(statistics, observation());
    const bounded = boundManagedModelStatistics(statistics);
    expect(bounded.coverage.gaps).toEqual([
      'unclosed_turn',
      'missing_usage',
      'counter_overflow',
    ]);
    expect(bounded.totals.tokens.prompt).toBe(Number.MAX_SAFE_INTEGER);
    expect(bounded.totals.requests.total).toBe(17);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      40 * 1024,
    );
  });
});
