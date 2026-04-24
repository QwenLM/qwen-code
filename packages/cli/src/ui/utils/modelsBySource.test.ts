/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  MAIN_SOURCE,
  type ModelMetrics,
  type ModelMetricsCore,
} from '@qwen-code/qwen-code-core';
import { flattenModelsBySource } from './modelsBySource.js';

const emptyCore = (): ModelMetricsCore => ({
  api: { totalRequests: 0, totalErrors: 0, totalLatencyMs: 0 },
  tokens: {
    prompt: 0,
    candidates: 0,
    total: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
  },
});

const coreWithRequests = (requests: number): ModelMetricsCore => ({
  ...emptyCore(),
  api: { totalRequests: requests, totalErrors: 0, totalLatencyMs: 0 },
});

const makeModel = (
  bySource: Record<string, ModelMetricsCore>,
): ModelMetrics => {
  const totalRequests = Object.values(bySource).reduce(
    (sum, m) => sum + m.api.totalRequests,
    0,
  );
  return {
    ...emptyCore(),
    api: { totalRequests, totalErrors: 0, totalLatencyMs: 0 },
    bySource,
  };
};

describe('flattenModelsBySource', () => {
  it('omits models with zero requests', () => {
    const entries = flattenModelsBySource({
      'idle-model': makeModel({}),
    });
    expect(entries).toEqual([]);
  });

  it('collapses to plain label when no non-main source exists in the session', () => {
    const entries = flattenModelsBySource({
      'glm-5': makeModel({ [MAIN_SOURCE]: coreWithRequests(3) }),
      'qwen-max': makeModel({ [MAIN_SOURCE]: coreWithRequests(2) }),
    });
    expect(entries.map((e) => e.label)).toEqual(['glm-5', 'qwen-max']);
    expect(entries.map((e) => e.key)).toEqual(['glm-5', 'qwen-max']);
  });

  it('splits every row when any model has a non-main source (session-wide rule)', () => {
    const entries = flattenModelsBySource({
      'glm-5': makeModel({ [MAIN_SOURCE]: coreWithRequests(2) }),
      'qwen-plus': makeModel({ researcher: coreWithRequests(1) }),
    });
    expect(entries.map((e) => e.label)).toEqual([
      'glm-5 (main)',
      'qwen-plus (researcher)',
    ]);
  });

  it('orders sources with MAIN_SOURCE first then alphabetically', () => {
    const entries = flattenModelsBySource({
      'glm-5': makeModel({
        bravo: coreWithRequests(1),
        [MAIN_SOURCE]: coreWithRequests(2),
        alpha: coreWithRequests(1),
      }),
    });
    expect(entries.map((e) => e.label)).toEqual([
      'glm-5 (main)',
      'glm-5 (alpha)',
      'glm-5 (bravo)',
    ]);
  });

  it('produces distinct keys when two raw model names normalize to the same label', () => {
    // `normalizeModelName` strips `-001`, so `foo` and `foo-001` both render
    // as the label `foo`. The React key must still be unique across entries.
    const entries = flattenModelsBySource({
      foo: makeModel({ [MAIN_SOURCE]: coreWithRequests(1) }),
      'foo-001': makeModel({ [MAIN_SOURCE]: coreWithRequests(1) }),
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual(['foo', 'foo']);
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['foo', 'foo-001']);
  });

  it('produces distinct keys across (model, source) pairs in the split case', () => {
    const entries = flattenModelsBySource({
      'glm-5': makeModel({
        [MAIN_SOURCE]: coreWithRequests(1),
        alpha: coreWithRequests(1),
      }),
      'qwen-plus': makeModel({
        alpha: coreWithRequests(1),
      }),
    });
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['glm-5::main', 'glm-5::alpha', 'qwen-plus::alpha']);
  });

  it('falls back to the aggregate when bySource is empty (defensive)', () => {
    // Callers shouldn't hit this, but the helper should still produce a
    // usable row rather than dropping the model.
    const entries = flattenModelsBySource({
      'glm-5': {
        ...coreWithRequests(1),
        bySource: {},
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe('glm-5');
    expect(entries[0]?.key).toBe('glm-5');
  });
});
