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
    const result = evaluateFixedPolicyCondition(
      expr(operator, ['field', 'resource.width'], right),
      CONTEXT,
    );
    expect(result.outcome).toBe(outcome);
  });

  it('compares field to field (the §8.3 keyframe-extraction example)', () => {
    const result = evaluateFixedPolicyCondition(
      expr(
        '>',
        ['field', 'resource.estimatedTokenCount'],
        ['field', 'session.availableContextTokens'],
      ),
      CONTEXT,
    );
    expect(result).toEqual({ outcome: 'match' });
  });

  it('compares literal to literal', () => {
    expect(evaluateFixedPolicyCondition(expr('<', 2, 3), CONTEXT).outcome).toBe(
      'match',
    );
  });

  it('== supports strict string/boolean equality; type mismatch is a determinate no_match', () => {
    expect(
      evaluateFixedPolicyCondition(expr('==', 'aac', 'aac'), CONTEXT).outcome,
    ).toBe('match');
    expect(
      evaluateFixedPolicyCondition(expr('==', '3', 3), CONTEXT).outcome,
    ).toBe('no_match');
    // ...and != is its exact complement, including across types.
    expect(
      evaluateFixedPolicyCondition(expr('!=', '3', 3), CONTEXT).outcome,
    ).toBe('match');
  });

  it('an absent field is unavailable, never false', () => {
    const result = evaluateFixedPolicyCondition(
      expr('>', ['field', 'resource.durationMs'], 0),
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('an unknown field name is unavailable and named', () => {
    const result = evaluateFixedPolicyCondition(
      expr('>', ['field', 'resource.doesNotExist'], 0),
      CONTEXT,
    );
    expect(result).toMatchObject({
      outcome: 'unavailable',
      missingFields: ['resource.doesNotExist'],
    });
  });

  it('both operands missing → both fields recorded', () => {
    const result = evaluateFixedPolicyCondition(
      expr(
        '>',
        ['field', 'resource.bitRate'],
        ['field', 'resource.sampleRateHz'],
      ),
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.bitRate', 'resource.sampleRateHz'],
    });
  });

  it('ordering over a non-numeric literal is unavailable, not false', () => {
    const result = evaluateFixedPolicyCondition(
      expr('>', ['field', 'resource.width'], 'wide'),
      CONTEXT,
    );
    expect(result).toMatchObject({ outcome: 'unavailable' });
  });
});

describe('evaluateFixedPolicyCondition — combinators (strong Kleene)', () => {
  const TRUE = expr('==', 1, 1);
  const FALSE = expr('==', 1, 2);
  const UNAVAILABLE = expr('>', ['field', 'resource.durationMs'], 0);

  it('all: every branch true → match', () => {
    expect(
      evaluateFixedPolicyCondition(expr('all', TRUE, TRUE), CONTEXT).outcome,
    ).toBe('match');
  });

  it('all: a false branch dominates an unavailable sibling', () => {
    expect(
      evaluateFixedPolicyCondition(expr('all', UNAVAILABLE, FALSE), CONTEXT)
        .outcome,
    ).toBe('no_match');
  });

  it('all: true + unavailable → unavailable with the missing field', () => {
    expect(
      evaluateFixedPolicyCondition(expr('all', TRUE, UNAVAILABLE), CONTEXT),
    ).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('any: a true branch dominates an unavailable sibling', () => {
    expect(
      evaluateFixedPolicyCondition(expr('any', UNAVAILABLE, TRUE), CONTEXT)
        .outcome,
    ).toBe('match');
  });

  it('any: every branch false → no_match', () => {
    expect(
      evaluateFixedPolicyCondition(expr('any', FALSE, FALSE), CONTEXT).outcome,
    ).toBe('no_match');
  });

  it('any: false + unavailable → unavailable', () => {
    expect(
      evaluateFixedPolicyCondition(expr('any', FALSE, UNAVAILABLE), CONTEXT),
    ).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('!: flips determinate outcomes', () => {
    expect(evaluateFixedPolicyCondition(expr('!', TRUE), CONTEXT).outcome).toBe(
      'no_match',
    );
    expect(
      evaluateFixedPolicyCondition(expr('!', FALSE), CONTEXT).outcome,
    ).toBe('match');
  });

  it('!: unavailable passes through — negation must not launder unknowns', () => {
    expect(
      evaluateFixedPolicyCondition(expr('!', UNAVAILABLE), CONTEXT),
    ).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('nests recursively and dedups missing fields', () => {
    const result = evaluateFixedPolicyCondition(
      expr(
        'any',
        expr('all', UNAVAILABLE, TRUE),
        expr('<', ['field', 'resource.durationMs'], 100),
      ),
      CONTEXT,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      missingFields: ['resource.durationMs'],
    });
  });

  it('vacuous combinators: ["all"] → match, ["any"] → no_match', () => {
    expect(evaluateFixedPolicyCondition(expr('all'), CONTEXT).outcome).toBe(
      'match',
    );
    expect(evaluateFixedPolicyCondition(expr('any'), CONTEXT).outcome).toBe(
      'no_match',
    );
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
  it('resolves presence flags from the memory context', () => {
    const withMemory: FixedPolicyConditionContext = {
      ...CONTEXT,
      memory: { hasTranscript: 1, hasOcr: 0 },
    };
    // The §4.1 trigger: "memory 中无完整 ASR 结果" — hasTranscript == 0.
    expect(
      evaluateFixedPolicyCondition(
        expr('==', ['field', 'memory.hasTranscript'], 0),
        withMemory,
      ).outcome,
    ).toBe('no_match');
    expect(
      evaluateFixedPolicyCondition(
        expr('==', ['field', 'memory.hasOcr'], 0),
        withMemory,
      ).outcome,
    ).toBe('match');
  });

  it('evaluates unavailable when the memory namespace is absent', () => {
    const result = evaluateFixedPolicyCondition(
      expr('==', ['field', 'memory.hasTranscript'], 0),
      CONTEXT,
    );
    expect(result.outcome).toBe('unavailable');
    expect(result).toMatchObject({ missingFields: ['memory.hasTranscript'] });
  });

  it('propagates memory unavailability through combinators (strong Kleene)', () => {
    // all(false, unavailable) is a determinate false — the missing memory
    // field is not decisive.
    expect(
      evaluateFixedPolicyCondition(
        expr(
          'all',
          ['<', ['field', 'resource.width'], 100],
          ['==', ['field', 'memory.hasTranscript'], 0],
        ),
        CONTEXT,
      ).outcome,
    ).toBe('no_match');
    // all(true, unavailable) stays unavailable.
    expect(
      evaluateFixedPolicyCondition(
        expr(
          'all',
          ['>', ['field', 'resource.durationMs'] as unknown[], 0],
          ['==', ['field', 'memory.hasTranscript'], 0],
        ),
        { ...CONTEXT, resource: { ...CONTEXT.resource, durationMs: 100 } },
      ).outcome,
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
    expect(
      conditionUsesNamespace(
        expr(
          'all',
          ['>', ['field', 'resource.durationMs'], 1_800_000],
          ['any', ['==', ['field', 'memory.hasTranscript'], 0]],
        ),
        'memory',
      ),
    ).toBe(true);
    expect(
      conditionUsesNamespace(
        expr('>', ['field', 'resource.width'], 2000),
        'memory',
      ),
    ).toBe(false);
    expect(
      conditionUsesNamespace(
        expr('>', ['field', 'resource.width'], 2000),
        'resource',
      ),
    ).toBe(true);
    expect(
      conditionUsesNamespace(
        expr('!', ['==', ['field', 'session.promptTokenCount'], 0]),
        'session',
      ),
    ).toBe(true);
  });
});
