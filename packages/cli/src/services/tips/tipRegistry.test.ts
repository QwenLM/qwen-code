/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tipRegistry, type TipContext } from './tipRegistry.js';

const baseCtx: TipContext = {
  lastPromptTokenCount: 0,
  contextWindowSize: 200_000,
  sessionPromptCount: 10,
  sessionCount: 1,
  platform: 'darwin',
  thresholds: {
    warn: 147_000,
    auto: 167_000,
    hard: 177_000,
    effectiveWindow: 180_000,
  },
};

function tipById(id: string) {
  return tipRegistry.find((t) => t.id === id)!;
}

describe('context-* tip thresholds align with computeThresholds', () => {
  it('compress-intro fires between warn and auto', () => {
    const t = tipById('compress-intro');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 100_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 168_000 })).toBe(
      false,
    );
  });

  it('context-high fires between auto and hard', () => {
    const t = tipById('context-high');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      false,
    );
  });

  it('context-critical fires at or above hard', () => {
    const t = tipById('context-critical');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      true,
    );
  });

  it('context-critical suppresses when hard === auto (R9.5 small-window collapse)', () => {
    // On small windows (e.g. 32K) computeThresholds collapses
    // hard to equal auto. The critical band [hard, ∞) starts at the
    // auto threshold; firing the tip there would claim "near hard
    // limit" when there is no distinct hard limit. R9.5: gate on
    // `hard > auto` like `currentTier` does. The `context-high` tip
    // in band `[auto, hard)` already covers small windows.
    const t = tipById('context-critical');
    const collapsedCtx = {
      ...baseCtx,
      thresholds: {
        effectiveWindow: 32_000,
        warn: 18_000,
        auto: 22_400,
        hard: 22_400, // collapsed to equal auto
      },
      lastPromptTokenCount: 25_000, // above the collapsed threshold
    };
    expect(t.isRelevant(collapsedCtx)).toBe(false);
  });

  it('falls back gracefully when thresholds undefined (legacy callers)', () => {
    const ctx = { ...baseCtx, thresholds: undefined };
    // All three context-* tips return false when thresholds are missing
    // (the comparison would be unsafe without them).
    expect(tipById('compress-intro').isRelevant(ctx)).toBe(false);
    expect(tipById('context-high').isRelevant(ctx)).toBe(false);
    expect(tipById('context-critical').isRelevant(ctx)).toBe(false);
  });

  it('compress-intro additionally gates on sessionPromptCount > 5', () => {
    const t = tipById('compress-intro');
    // Above warn, below auto, but session is too new.
    expect(
      t.isRelevant({
        ...baseCtx,
        lastPromptTokenCount: 150_000,
        sessionPromptCount: 3,
      }),
    ).toBe(false);
    expect(
      t.isRelevant({
        ...baseCtx,
        lastPromptTokenCount: 150_000,
        sessionPromptCount: 6,
      }),
    ).toBe(true);
  });
});
