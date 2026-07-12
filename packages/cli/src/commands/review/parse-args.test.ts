/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseReviewArgs,
  tokenizeArgs,
  type ParsedReviewArgs,
} from './parse-args.js';

describe('tokenizeArgs', () => {
  it('splits on whitespace and collapses runs', () => {
    expect(tokenizeArgs('  6711   --comment ')).toEqual(['6711', '--comment']);
  });

  it('honours double- and single-quoted segments', () => {
    expect(tokenizeArgs('"src/my file.ts" --effort low')).toEqual([
      'src/my file.ts',
      '--effort',
      'low',
    ]);
    expect(tokenizeArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  it('returns an empty list for an empty string', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
  });
});

/**
 * Table-driven cases. Each row that reproduces a previously-shipped parsing
 * bug names it, so a regression is recognizable at a glance.
 */
interface Case {
  name: string;
  raw: string;
  expect: Partial<ParsedReviewArgs> & {
    targetType: ParsedReviewArgs['target']['type'];
    warningCount?: number;
  };
}

const CASES: Case[] = [
  {
    name: 'no arguments → local diff at medium',
    raw: '',
    expect: {
      targetType: 'local',
      effort: 'medium',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'PR number → high by default',
    raw: '6711',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'file path → medium by default',
    raw: 'src/foo.ts',
    expect: {
      targetType: 'file',
      effort: 'medium',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'PR URL → owner/repo/number extracted',
    raw: 'https://github.com/QwenLM/qwen-code/pull/6711',
    expect: { targetType: 'pr-url', effort: 'high', warningCount: 0 },
  },
  {
    name: 'explicit effort on a PR',
    raw: '6711 --effort medium',
    expect: {
      targetType: 'pr-number',
      effort: 'medium',
      effortSource: 'explicit',
      warningCount: 0,
    },
  },
  {
    name: 'equals form parses without consuming a second token (bug: undefined = form)',
    raw: '--effort=low src/foo.ts',
    expect: {
      targetType: 'file',
      effort: 'low',
      effortSource: 'explicit',
      warningCount: 0,
    },
  },
  {
    name: 'invalid equals value warns, falls back, touches nothing else (bug: = form undefined)',
    raw: '6711 --effort=typo',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 1,
    },
  },
  {
    name: 'invalid spaced value is discarded when another token is the target (bug: typo leaked into disambiguation)',
    raw: '6711 --effort typo',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      extraTokens: [],
      warningCount: 1,
    },
  },
  {
    name: 'invalid spaced value survives as the sole target candidate',
    raw: '--effort 6711',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 1,
    },
  },
  {
    name: 'a following flag is never consumed as the value (bug: --effort --comment ate the flag)',
    raw: '6711 --effort --comment',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      comment: { requested: true, effective: true },
      warningCount: 1,
    },
  },
  {
    name: 'flag-final --effort warns and defaults',
    raw: '6711 --effort',
    expect: { targetType: 'pr-number', effort: 'high', warningCount: 1 },
  },
  {
    name: '--comment on a PR is effective and forces high over an explicit lower effort',
    raw: '6711 --comment --effort low',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'forced-by-comment',
      comment: { requested: true, effective: true },
      warningCount: 1,
    },
  },
  {
    name: 'ignored --comment on a non-PR must not change the effort (bug: silently-forced high)',
    raw: 'src/foo.ts --comment --effort low',
    expect: {
      targetType: 'file',
      effort: 'low',
      effortSource: 'explicit',
      comment: { requested: true, effective: false },
      warningCount: 1,
    },
  },
  {
    name: '--commentary is not --comment (substring guard)',
    raw: '6711 --commentary',
    expect: {
      targetType: 'pr-number',
      comment: { requested: false, effective: false },
      unknownFlags: ['--commentary'],
      warningCount: 1,
    },
  },
  {
    name: 'extra positional tokens are reported, not guessed at',
    raw: '6711 typo2',
    expect: {
      targetType: 'pr-number',
      extraTokens: ['typo2'],
      warningCount: 1,
    },
  },
];

describe('parseReviewArgs', () => {
  it.each(CASES)('$name', (c) => {
    const got = parseReviewArgs(c.raw);
    const { targetType, warningCount, ...rest } = c.expect;
    expect(got.target.type).toBe(targetType);
    if (warningCount !== undefined) {
      expect(got.warnings).toHaveLength(warningCount);
    }
    for (const [key, value] of Object.entries(rest)) {
      expect(got[key as keyof ParsedReviewArgs]).toEqual(value);
    }
  });

  it('extracts owner/repo/number from a PR URL', () => {
    const got = parseReviewArgs('https://github.com/QwenLM/qwen-code/pull/42');
    expect(got.target).toEqual({
      type: 'pr-url',
      url: 'https://github.com/QwenLM/qwen-code/pull/42',
      owner: 'QwenLM',
      repo: 'qwen-code',
      number: 42,
    });
  });

  it('last explicit effort wins when repeated', () => {
    const got = parseReviewArgs('6711 --effort low --effort medium');
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('explicit');
  });
});
