/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { billableOutputTokens, calculateCost } from './costCalculator.js';

describe('calculateCost', () => {
  it('calculates cost correctly with both input and output pricing', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricing: {
        inputPerMillionTokens: 0.3,
        outputPerMillionTokens: 1.2,
      },
    });

    // 1M input tokens * $0.30/M = $0.30
    // 1M output tokens * $1.20/M = $1.20
    // Total = $1.50
    expect(cost).toBe(1.5);
  });

  it('returns null when pricing is not defined', () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      pricing: undefined,
    });

    expect(cost).toBeNull();
  });

  it('handles only input pricing', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricing: {
        inputPerMillionTokens: 0.3,
      },
    });

    // 1M input tokens * $0.30/M = $0.30
    // No output pricing, so outputCost = 0
    // Total = $0.30
    expect(cost).toBe(0.3);
  });

  it('handles only output pricing', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricing: {
        outputPerMillionTokens: 1.2,
      },
    });

    // No input pricing, so inputCost = 0
    // 1M output tokens * $1.20/M = $1.20
    // Total = $1.20
    expect(cost).toBe(1.2);
  });

  it('returns null for zero tokens when pricing is defined', () => {
    const cost = calculateCost({
      inputTokens: 0,
      outputTokens: 0,
      pricing: {
        inputPerMillionTokens: 0.3,
        outputPerMillionTokens: 1.2,
      },
    });

    expect(cost).toBeNull();
  });

  it('returns zero rather than null for a model priced at zero', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      pricing: {
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
      },
    });

    expect(cost).toBe(0);
  });

  it('returns a number when only one side is priced at zero', () => {
    expect(
      calculateCost({
        inputTokens: 1_000_000,
        outputTokens: 0,
        pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 1.2 },
      }),
    ).toBe(0);
    expect(
      calculateCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 1.2 },
      }),
    ).toBe(1.2);
  });

  // Guards against over-correcting. `null` still has to mean "nothing to
  // report", or the stats table would print `$0.0000` for models the user
  // never priced and for models with no recorded usage. Both pass before and
  // after the fix.
  it('keeps null for an unpriced model regardless of token counts', () => {
    expect(
      calculateCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricing: {},
      }),
    ).toBeNull();
    expect(
      calculateCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricing: undefined,
      }),
    ).toBeNull();
  });

  it('keeps null for an unused model even when it is priced at zero', () => {
    expect(
      calculateCost({
        inputTokens: 0,
        outputTokens: 0,
        pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
      }),
    ).toBeNull();
  });

  it('handles partial tokens correctly', () => {
    const cost = calculateCost({
      inputTokens: 500_000,
      outputTokens: 250_000,
      pricing: {
        inputPerMillionTokens: 0.3,
        outputPerMillionTokens: 1.2,
      },
    });

    // 500K input tokens * $0.30/M = $0.15
    // 250K output tokens * $1.20/M = $0.30
    // Total = $0.45
    expect(cost).toBeCloseTo(0.45);
  });

  it('returns null when pricing object is empty', () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      pricing: {},
    });

    expect(cost).toBeNull();
  });

  it('returns null when pricing has null/undefined values', () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      pricing: {
        inputPerMillionTokens: undefined,
        outputPerMillionTokens: undefined,
      },
    });

    expect(cost).toBeNull();
  });

  it('handles very small token counts', () => {
    const cost = calculateCost({
      inputTokens: 1,
      outputTokens: 1,
      pricing: {
        inputPerMillionTokens: 1.0,
        outputPerMillionTokens: 2.0,
      },
    });

    // 1 token * $1.0/M = $0.000001
    // 1 token * $2.0/M = $0.000002
    // Total = $0.000003
    expect(cost).toBeCloseTo(0.000003, 10);
  });

  it('handles very large token counts', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000_000, // 1B tokens
      outputTokens: 500_000_000,
      pricing: {
        inputPerMillionTokens: 0.3,
        outputPerMillionTokens: 1.2,
      },
    });

    // 1B input tokens * $0.30/M = $300
    // 500M output tokens * $1.20/M = $600
    // Total = $900
    expect(cost).toBe(900);
  });

  it('handles zero input tokens with output pricing', () => {
    const cost = calculateCost({
      inputTokens: 0,
      outputTokens: 1_000_000,
      pricing: {
        outputPerMillionTokens: 1.2,
      },
    });

    expect(cost).toBe(1.2);
  });

  it('handles zero output tokens with input pricing', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      pricing: {
        inputPerMillionTokens: 0.3,
      },
    });

    expect(cost).toBe(0.3);
  });

  it('handles fractional pricing', () => {
    const cost = calculateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricing: {
        inputPerMillionTokens: 0.123456,
        outputPerMillionTokens: 0.654321,
      },
    });

    expect(cost).toBeCloseTo(0.777777, 6);
  });

  it('rounds to 4 decimal places in display format', () => {
    const cost = calculateCost({
      inputTokens: 123_456,
      outputTokens: 789_012,
      pricing: {
        inputPerMillionTokens: 0.3,
        outputPerMillionTokens: 1.2,
      },
    });

    // 123,456 * $0.30/M = $0.0370368
    // 789,012 * $1.20/M = $0.9468144
    // Total = $0.9838512
    expect(cost).toBeCloseTo(0.9838512, 7);
    // Verify the toFixed(4) formatting that the UI uses
    expect(cost?.toFixed(4)).toBe('0.9839');
  });
});

describe('billableOutputTokens', () => {
  it('derives total - prompt when reasoning sits inside candidates', () => {
    // OpenAI-style: total already counts the reasoning in `candidates`.
    expect(
      billableOutputTokens({
        prompt: 100_000,
        candidates: 150_000,
        thoughts: 120_000,
        total: 250_000,
      }),
    ).toBe(150_000);
  });

  it('derives total - prompt when thoughts are disjoint from candidates', () => {
    // Gemini-style: the derivation must equal candidates + thoughts exactly.
    expect(
      billableOutputTokens({
        prompt: 100_000,
        candidates: 50_000,
        thoughts: 120_000,
        total: 270_000,
      }),
    ).toBe(170_000);
  });

  it('refuses a derived figure above the band (operand did not survive)', () => {
    // A total-only record: prompt never arrived, so the whole total -- mostly
    // input -- would otherwise be billed at the output rate.
    expect(
      billableOutputTokens({
        prompt: 0,
        candidates: 0,
        thoughts: 0,
        total: 250_000,
      }),
    ).toBe(0);
    // A cached-only prompt coerces prompt to 0 while total keeps the cache:
    // derived 52_000 against a band of [10_000, 12_000].
    expect(
      billableOutputTokens({
        prompt: 0,
        candidates: 10_000,
        thoughts: 2_000,
        total: 52_000,
      }),
    ).toBe(12_000);
  });

  it('refuses a derived figure below the band (short total)', () => {
    // One total-less event among complete ones subtracts an unreported prompt
    // from the other events' output: derived 180_000 < candidates 190_000.
    expect(
      billableOutputTokens({
        prompt: 110_000,
        candidates: 190_000,
        thoughts: 0,
        total: 290_000,
      }),
    ).toBe(190_000);
  });

  it('keeps the band lower bound inclusive', () => {
    // derived === candidates exactly: the aggregate counts no thoughts beyond
    // candidates, so it is still trustworthy and must not fall through to the
    // sum (which would bill 170_000 here). The upper bound needs no such leg:
    // at derived === candidates + thoughts both paths return the same value.
    expect(
      billableOutputTokens({
        prompt: 100_000,
        candidates: 50_000,
        thoughts: 120_000,
        total: 150_000,
      }),
    ).toBe(50_000);
  });

  it('keeps candidates + thoughts when no usable total is reported', () => {
    // Summing is the only fallback that keeps a disjoint provider's reasoning
    // billable, whatever the relative size of the two counts.
    expect(
      billableOutputTokens({
        prompt: 100_000,
        candidates: 150_000,
        thoughts: 120_000,
        total: 0,
      }),
    ).toBe(270_000);
    expect(
      billableOutputTokens({
        prompt: 100_000,
        candidates: 50_000,
        thoughts: 120_000,
        total: 0,
      }),
    ).toBe(170_000);
  });
});
