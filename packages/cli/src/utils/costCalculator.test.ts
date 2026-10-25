/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { calculateCost, getCostOutputTokens } from './costCalculator.js';

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

describe('getCostOutputTokens', () => {
  it.each([
    {
      name: 'cached input remains input when the prompt count is absent',
      tokens: {
        prompt: 0,
        cached: 5000,
        candidates: 200,
        thoughts: 0,
        total: 5200,
      },
      expected: 200,
    },
    {
      name: 'an aggregate total alone is not evidence of output usage',
      tokens: {
        prompt: 0,
        cached: 0,
        candidates: 200,
        thoughts: 0,
        total: 5200,
      },
      expected: 200,
    },
    {
      name: 'a total-only report does not invent output tokens',
      tokens: { prompt: 0, cached: 0, candidates: 0, thoughts: 0, total: 5 },
      expected: 0,
    },
  ])(
    'does not bill unaccounted input as output: $name',
    ({ tokens, expected }) => {
      expect(getCostOutputTokens(tokens)).toBe(expected);
    },
  );

  it.each([
    {
      name: 'OpenAI reasoning included in candidates',
      tokens: {
        prompt: 100000,
        candidates: 150000,
        total: 250000,
        thoughts: 120000,
      },
      expected: 150000,
    },
    {
      name: 'Gemini reasoning disjoint from candidates',
      tokens: {
        prompt: 100000,
        candidates: 50000,
        total: 270000,
        thoughts: 120000,
      },
      expected: 170000,
    },
    {
      name: 'reported total overrides the fallback when candidates exceed thoughts',
      tokens: {
        prompt: 100000,
        candidates: 150000,
        total: 300000,
        thoughts: 50000,
      },
      expected: 200000,
    },
    {
      name: 'reported total overrides the fallback when reasoning equals candidates',
      tokens: {
        prompt: 100000,
        candidates: 120000,
        total: 250000,
        thoughts: 120000,
      },
      expected: 150000,
    },
  ])(
    'derives output from the aggregate total: $name',
    ({ tokens, expected }) => {
      expect(getCostOutputTokens({ cached: 0, ...tokens })).toBe(expected);
    },
  );

  it.each([
    {
      name: 'OpenAI fallback keeps included reasoning only once',
      tokens: {
        prompt: 100000,
        candidates: 150000,
        total: 0,
        thoughts: 120000,
      },
      expected: 150000,
    },
    {
      name: 'Gemini fallback retains disjoint reasoning',
      tokens: { prompt: 100000, candidates: 50000, total: 0, thoughts: 120000 },
      expected: 170000,
    },
    {
      name: 'unusable positive total does not clamp output to zero',
      tokens: {
        prompt: 100000,
        candidates: 200000,
        total: 100000,
        thoughts: 50000,
      },
      expected: 200000,
    },
    {
      name: 'equal candidates and thoughts are billed only once',
      tokens: {
        prompt: 1000,
        candidates: 800,
        total: 0,
        thoughts: 800,
      },
      expected: 800,
    },
  ])(
    'uses the existing fallback when total is unavailable or unusable: $name',
    ({ tokens, expected }) => {
      expect(getCostOutputTokens({ cached: 0, ...tokens })).toBe(expected);
    },
  );
});
