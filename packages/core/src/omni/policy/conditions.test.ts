/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  FixedPolicyCondition,
  FixedPolicyConditionContext,
} from './conditions.js';
import {
  evaluateFixedPolicyCondition,
  validateFixedPolicyCondition,
} from './conditions.js';

const CONTEXT: FixedPolicyConditionContext = {
  resource: {
    sizeBytes: 8_200_000,
    width: 4096,
    height: 3072,
    estimatedTokenCount: 150_000,
  },
  request: { totalEstimatedMediaTokens: 180_000 },
  session: {
    contextWindowTokens: 131_072,
    promptTokenCount: 20_000,
    reservedOutputTokens: 8_192,
    availableContextTokens: 102_880,
  },
};

const cmp = (
  left: object,
  operator: string,
  right: object,
): FixedPolicyCondition =>
  ({ left, operator, right }) as unknown as FixedPolicyCondition;

describe('evaluateFixedPolicyCondition — comparisons', () => {
  it.each([
    // [operator, right literal, expected outcome] against width=4096
    ['gt', 4095, 'match'],
    ['gt', 4096, 'no_match'],
    ['gte', 4096, 'match'],
    ['gte', 4097, 'no_match'],
    ['lt', 4097, 'match'],
    ['lt', 4096, 'no_match'],
    ['lte', 4096, 'match'],
    ['lte', 4095, 'no_match'],
    ['eq', 4096, 'match'],
    ['eq', 4095, 'no_match'],
  ] as const)('width %s %d → %s', (operator, right, outcome) => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.width' }, operator, { value: right }),
      CONTEXT,
    );
    expect(result.outcome).toBe(outcome);
  });

  it('compares field to field (the §8.3 keyframe-extraction example)', () => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.estimatedTokenCount' }, 'gt', {
        field: 'session.availableContextTokens',
      }),
      CONTEXT,
    );
    expect(result).toEqual({ outcome: 'match' });
  });

  it('compares literal to literal', () => {
    expect(
      evaluateFixedPolicyCondition(
        cmp({ value: 2 }, 'lt', { value: 3 }),
        CONTEXT,
      ).outcome,
    ).toBe('match');
  });

  it('eq supports strict string/boolean equality; type mismatch is a determinate no_match', () => {
    expect(
      evaluateFixedPolicyCondition(
        cmp({ value: 'aac' }, 'eq', { value: 'aac' }),
        CONTEXT,
      ).outcome,
    ).toBe('match');
    expect(
      evaluateFixedPolicyCondition(
        cmp({ value: '3' }, 'eq', { value: 3 }),
        CONTEXT,
      ).outcome,
    ).toBe('no_match');
  });

  it('an absent field is unavailable, never false', () => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.durationMs' }, 'gt', { value: 0 }),
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('an unknown field name is unavailable and named', () => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.doesNotExist' }, 'gt', { value: 0 }),
      CONTEXT,
    );
    expect(result).toMatchObject({
      outcome: 'unavailable',
      missingFields: ['resource.doesNotExist'],
    });
  });

  it('both operands missing → both fields recorded', () => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.bitRate' }, 'gt', {
        field: 'resource.sampleRateHz',
      }),
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.bitRate', 'resource.sampleRateHz'],
    });
  });

  it('ordering over a non-numeric literal is unavailable, not false', () => {
    const result = evaluateFixedPolicyCondition(
      cmp({ field: 'resource.width' }, 'gt', { value: 'wide' }),
      CONTEXT,
    );
    expect(result).toMatchObject({ outcome: 'unavailable' });
  });
});

describe('evaluateFixedPolicyCondition — combinators (strong Kleene)', () => {
  const TRUE = cmp({ value: 1 }, 'eq', { value: 1 });
  const FALSE = cmp({ value: 1 }, 'eq', { value: 2 });
  const UNAVAILABLE = cmp({ field: 'resource.durationMs' }, 'gt', {
    value: 0,
  });

  it('all: every branch true → match', () => {
    expect(
      evaluateFixedPolicyCondition({ all: [TRUE, TRUE] }, CONTEXT).outcome,
    ).toBe('match');
  });

  it('all: a false branch dominates an unavailable sibling', () => {
    expect(
      evaluateFixedPolicyCondition({ all: [UNAVAILABLE, FALSE] }, CONTEXT)
        .outcome,
    ).toBe('no_match');
  });

  it('all: true + unavailable → unavailable with the missing field', () => {
    expect(
      evaluateFixedPolicyCondition({ all: [TRUE, UNAVAILABLE] }, CONTEXT),
    ).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('any: a true branch dominates an unavailable sibling', () => {
    expect(
      evaluateFixedPolicyCondition({ any: [UNAVAILABLE, TRUE] }, CONTEXT)
        .outcome,
    ).toBe('match');
  });

  it('any: every branch false → no_match', () => {
    expect(
      evaluateFixedPolicyCondition({ any: [FALSE, FALSE] }, CONTEXT).outcome,
    ).toBe('no_match');
  });

  it('any: false + unavailable → unavailable', () => {
    expect(
      evaluateFixedPolicyCondition({ any: [FALSE, UNAVAILABLE] }, CONTEXT),
    ).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('nests recursively and dedups missing fields', () => {
    const result = evaluateFixedPolicyCondition(
      {
        any: [
          { all: [UNAVAILABLE, TRUE] },
          cmp({ field: 'resource.durationMs' }, 'lt', { value: 100 }),
        ],
      },
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('vacuous combinators: all [] → match, any [] → no_match', () => {
    expect(evaluateFixedPolicyCondition({ all: [] }, CONTEXT).outcome).toBe(
      'match',
    );
    expect(evaluateFixedPolicyCondition({ any: [] }, CONTEXT).outcome).toBe(
      'no_match',
    );
  });

  it('never throws on malformed nodes — degrades to unavailable', () => {
    for (const bad of [
      null,
      42,
      'gt',
      {},
      { all: 'not-an-array' },
      { left: { field: 'resource.width' } }, // no operator/right
      { left: {}, operator: 'between', right: {} },
    ]) {
      const result = evaluateFixedPolicyCondition(
        bad as unknown as FixedPolicyCondition,
        CONTEXT,
      );
      expect(result.outcome).toBe('unavailable');
    }
  });
});

describe('validateFixedPolicyCondition', () => {
  it('accepts the §8.3 documentation example', () => {
    expect(
      validateFixedPolicyCondition({
        all: [
          {
            left: { field: 'resource.estimatedTokenCount' },
            operator: 'gt',
            right: { field: 'session.availableContextTokens' },
          },
          {
            left: { field: 'session.contextWindowTokens' },
            operator: 'gte',
            right: { value: 131072 },
          },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ['non-object root', 7, /must be an object/],
    ['empty object', {}, /exactly one of/],
    ['both all and any', { all: [], any: [] }, /exactly one of/],
    ['empty all', { all: [] }, /non-empty array/],
    ['non-array any', { any: {} }, /non-empty array/],
    [
      'unknown operator',
      {
        left: { value: 1 },
        operator: 'between',
        right: { value: 2 },
      },
      /operator/,
    ],
    [
      'unknown field',
      {
        left: { field: 'resource.nope' },
        operator: 'gt',
        right: { value: 1 },
      },
      /unknown field/,
    ],
    [
      'operand with both field and value',
      {
        left: { field: 'resource.width', value: 1 },
        operator: 'gt',
        right: { value: 1 },
      },
      /exactly one of "field"\/"value"/,
    ],
    [
      'operand with neither field nor value',
      { left: {}, operator: 'gt', right: { value: 1 } },
      /exactly one of "field"\/"value"/,
    ],
    [
      'ordering operator with a string literal',
      {
        left: { field: 'resource.width' },
        operator: 'gt',
        right: { value: 'wide' },
      },
      /requires a finite numeric literal/,
    ],
    [
      'non-primitive literal',
      {
        left: { value: { nested: true } },
        operator: 'eq',
        right: { value: 1 },
      },
      /number, string, or boolean/,
    ],
  ])('rejects %s', (_label, raw, pattern) => {
    const errors = validateFixedPolicyCondition(raw);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('eq allows string and boolean literals', () => {
    expect(
      validateFixedPolicyCondition({
        left: { value: true },
        operator: 'eq',
        right: { value: 'x' },
      }),
    ).toEqual([]);
  });

  it('reports nested paths for errors inside combinators', () => {
    const errors = validateFixedPolicyCondition({
      any: [
        {
          all: [{ left: { value: 1 }, operator: 'nope', right: { value: 2 } }],
        },
      ],
    });
    expect(errors.join('\n')).toContain('when.any[0].all[0].operator');
  });
});
