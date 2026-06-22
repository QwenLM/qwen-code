/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { calculateCost } from './costCalculator.js';

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
