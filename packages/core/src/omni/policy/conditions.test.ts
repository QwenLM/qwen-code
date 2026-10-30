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
  conditionUsesNamespace,
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

const expr = (...parts: unknown[]): FixedPolicyCondition =>
  parts as unknown as FixedPolicyCondition;

const evaluate = (condition: FixedPolicyCondition, context = CONTEXT) =>
  evaluateFixedPolicyCondition(condition, context);
const outcomeOf = (condition: FixedPolicyCondition, context = CONTEXT) =>
  evaluate(condition, context).outcome;
const unavailable = (...missingFields: string[]) => ({
  outcome: 'unavailable',
  missingFields,
});

describe('evaluateFixedPolicyCondition — comparisons', () => {
  it.each([
    // [operator, right literal, expected outcome] against width=4096
    ['>', 4095, 'match'],
    ['>', 4096, 'no_match'],
    ['>=', 4096, 'match'],
    ['>=', 4097, 'no_match'],
    ['<', 4097, 'match'],
    ['<', 4096, 'no_match'],
    ['<=', 4096, 'match'],
    ['<=', 4095, 'no_match'],
    ['==', 4096, 'match'],
    ['==', 4095, 'no_match'],
    ['!=', 4095, 'match'],
    ['!=', 4096, 'no_match'],
  ] as const)('width %s %d → %s', (operator, right, outcome) => {
    expect(outcomeOf(expr(operator, ['field', 'resource.width'], right))).toBe(
      outcome,
    );
  });

  it('compares field to field (the §8.3 keyframe-extraction example)', () => {
    const result = evaluate(
      expr(
        '>',
        ['field', 'resource.estimatedTokenCount'],
        ['field', 'session.availableContextTokens'],
      ),
    );
    expect(result).toEqual({ outcome: 'match' });
  });

  it('compares literal to literal', () => {
    expect(outcomeOf(expr('<', 2, 3))).toBe('match');
  });

  it('== supports strict string/boolean equality; type mismatch is a determinate no_match', () => {
    expect(outcomeOf(expr('==', 'aac', 'aac'))).toBe('match');
    expect(outcomeOf(expr('==', '3', 3))).toBe('no_match');
    // ...and != is its exact complement, including across types.
    expect(outcomeOf(expr('!=', '3', 3))).toBe('match');
  });

  it('an absent field is unavailable, never false', () => {
    expect(evaluate(expr('>', ['field', 'resource.durationMs'], 0))).toEqual(
      unavailable('resource.durationMs'),
    );
  });

  it('an unknown field name is unavailable and named', () => {
    expect(
      evaluate(expr('>', ['field', 'resource.doesNotExist'], 0)),
    ).toMatchObject(unavailable('resource.doesNotExist'));
  });

  it('both operands missing → both fields recorded', () => {
    const result = evaluate(
      expr(
        '>',
        ['field', 'resource.bitRate'],
        ['field', 'resource.sampleRateHz'],
      ),
    );
    expect(result).toEqual(
      unavailable('resource.bitRate', 'resource.sampleRateHz'),
    );
  });

  it('ordering over a non-numeric literal is unavailable, not false', () => {
    expect(
      evaluate(expr('>', ['field', 'resource.width'], 'wide')),
    ).toMatchObject({ outcome: 'unavailable' });
  });
});

describe('evaluateFixedPolicyCondition — combinators (strong Kleene)', () => {
  const TRUE = expr('==', 1, 1);
  const FALSE = expr('==', 1, 2);
  const UNAVAILABLE = expr('>', ['field', 'resource.durationMs'], 0);

  it.each([
    ['all: every branch true → match', expr('all', TRUE, TRUE), 'match'],
    [
      'all: a false branch dominates an unavailable sibling',
      expr('all', UNAVAILABLE, FALSE),
      'no_match',
    ],
    [
      'any: a true branch dominates an unavailable sibling',
      expr('any', UNAVAILABLE, TRUE),
      'match',
    ],
    [
      'any: every branch false → no_match',
      expr('any', FALSE, FALSE),
      'no_match',
    ],
  ])('%s', (_title, condition, outcome) => {
    expect(outcomeOf(condition)).toBe(outcome);
  });

  it.each([
    [
      'all: true + unavailable → unavailable with the missing field',
      expr('all', TRUE, UNAVAILABLE),
    ],
    ['any: false + unavailable → unavailable', expr('any', FALSE, UNAVAILABLE)],
    [
      '!: unavailable passes through — negation must not launder unknowns',
      expr('!', UNAVAILABLE),
    ],
    [
      'nests recursively and dedups missing fields',
      expr(
        'any',
        expr('all', UNAVAILABLE, TRUE),
        expr('<', ['field', 'resource.durationMs'], 100),
      ),
    ],
  ])('%s', (_title, condition) => {
    expect(evaluate(condition)).toEqual(unavailable('resource.durationMs'));
  });

  it('!: flips determinate outcomes', () => {
    expect(outcomeOf(expr('!', TRUE))).toBe('no_match');
    expect(outcomeOf(expr('!', FALSE))).toBe('match');
  });

  it('vacuous combinators: ["all"] → match, ["any"] → no_match', () => {
    expect(outcomeOf(expr('all'))).toBe('match');
    expect(outcomeOf(expr('any'))).toBe('no_match');
  });

  it('never throws on malformed nodes — degrades to unavailable', () => {
    for (const bad of [
      null,
      42,
      'gt',
      {},
      [],
      ['between', 1, 2],
      ['>', 1], // wrong arity
      ['>', 1, 2, 3], // wrong arity
      ['!'], // missing operand
      ['!', TRUE, FALSE], // extra operand
      ['>', ['field'], 1], // malformed field reference
      // The retired object form must degrade, not silently match.
      {
        left: { field: 'resource.width' },
        operator: 'gt',
        right: { value: 1 },
      },
    ]) {
      expect(outcomeOf(bad as unknown as FixedPolicyCondition)).toBe(
        'unavailable',
      );
    }
  });
});

describe('validateFixedPolicyCondition', () => {
  it('accepts the §8.3 documentation example', () => {
    expect(
      validateFixedPolicyCondition([
        'all',
        [
          '>',
          ['field', 'resource.estimatedTokenCount'],
          ['field', 'session.availableContextTokens'],
        ],
        ['>=', ['field', 'session.contextWindowTokens'], 131072],
      ]),
    ).toEqual([]);
  });

  it('accepts negation and != comparisons', () => {
    expect(
      validateFixedPolicyCondition([
        '!',
        ['!=', ['field', 'resource.channels'], 2],
      ]),
    ).toEqual([]);
  });

  it.each([
    ['non-array root', 7, /must be an expression array/],
    ['empty array', [], /must be an expression array/],
    ['non-string head', [42, 1, 2], /must be an expression array/],
    ['bare all', ['all'], /"all" requires at least one operand/],
    ['bare any', ['any'], /"any" requires at least one operand/],
    ['! with two operands', ['!', ['==', 1, 1], ['==', 2, 2]], /exactly one/],
    ['unknown operator', ['between', 1, 2], /unknown operator "between"/],
    ['comparison arity', ['>', 1], /takes exactly two operands/],
    ['unknown field', ['>', ['field', 'resource.nope'], 1], /unknown field/],
    [
      'malformed field reference',
      ['>', ['field'], 1],
      /field reference must be/,
    ],
    [
      'array that is not a field reference',
      ['>', ['resource.width'], 1],
      /field reference must be/,
    ],
    [
      'ordering operator with a string literal',
      ['>', ['field', 'resource.width'], 'wide'],
      /requires a finite numeric literal/,
    ],
    [
      'non-primitive literal',
      ['==', { nested: true }, 1],
      /number, string, or boolean/,
    ],
    [
      'legacy object form gets a migration hint',
      {
        left: { field: 'resource.width' },
        operator: 'gt',
        right: { value: 3000 },
      },
      /no longer supported/,
    ],
  ])('rejects %s', (_label, raw, pattern) => {
    const errors = validateFixedPolicyCondition(raw);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('== and != allow string and boolean literals', () => {
    expect(validateFixedPolicyCondition(['==', true, 'x'])).toEqual([]);
    expect(validateFixedPolicyCondition(['!=', 'aac', 'opus'])).toEqual([]);
  });

  it('reports nested positional paths for errors inside combinators', () => {
    const errors = validateFixedPolicyCondition([
      'any',
      ['all', ['nope', 1, 2]],
    ]);
    expect(errors.join('\n')).toContain('when[1][1][0]');
  });
});

describe('memory.* namespace (policy design §4.1/4.4)', () => {
  const NO_TRANSCRIPT = expr('==', ['field', 'memory.hasTranscript'], 0);

  it('resolves presence flags from the memory context', () => {
    const withMemory: FixedPolicyConditionContext = {
      ...CONTEXT,
      memory: { hasTranscript: 1, hasOcr: 0 },
    };
    // The §4.1 trigger: "memory 中无完整 ASR 结果" — hasTranscript == 0.
    expect(outcomeOf(NO_TRANSCRIPT, withMemory)).toBe('no_match');
    expect(
      outcomeOf(expr('==', ['field', 'memory.hasOcr'], 0), withMemory),
    ).toBe('match');
  });

  it('evaluates unavailable when the memory namespace is absent', () => {
    const result = evaluate(NO_TRANSCRIPT);
    expect(result.outcome).toBe('unavailable');
    expect(result).toMatchObject({ missingFields: ['memory.hasTranscript'] });
  });

  it('propagates memory unavailability through combinators (strong Kleene)', () => {
    // all(false, unavailable) is a determinate false — the missing memory
    // field is not decisive.
    expect(
      outcomeOf(
        expr('all', ['<', ['field', 'resource.width'], 100], NO_TRANSCRIPT),
      ),
    ).toBe('no_match');
    // all(true, unavailable) stays unavailable.
    expect(
      outcomeOf(
        expr(
          'all',
          ['>', ['field', 'resource.durationMs'] as unknown[], 0],
          NO_TRANSCRIPT,
        ),
        { ...CONTEXT, resource: { ...CONTEXT.resource, durationMs: 100 } },
      ),
    ).toBe('unavailable');
  });

  it('accepts memory fields in structural validation', () => {
    expect(
      validateFixedPolicyCondition(['==', ['field', 'memory.hasOcr'], 0]),
    ).toEqual([]);
    const errors = validateFixedPolicyCondition([
      '==',
      ['field', 'memory.hasBogus'],
      0,
    ]);
    expect(errors.join('\n')).toMatch(/unknown field/);
  });

  it('conditionUsesNamespace detects memory references through nesting', () => {
    const nested = expr(
      'all',
      ['>', ['field', 'resource.durationMs'], 1_800_000],
      ['any', ['==', ['field', 'memory.hasTranscript'], 0]],
    );
    const wide = expr('>', ['field', 'resource.width'], 2000);
    const negated = expr('!', ['==', ['field', 'session.promptTokenCount'], 0]);
    expect(conditionUsesNamespace(nested, 'memory')).toBe(true);
    expect(conditionUsesNamespace(wide, 'memory')).toBe(false);
    expect(conditionUsesNamespace(wide, 'resource')).toBe(true);
    expect(conditionUsesNamespace(negated, 'session')).toBe(true);
  });
});
