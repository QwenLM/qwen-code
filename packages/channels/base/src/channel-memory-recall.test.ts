import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS,
  CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS,
  CHANNEL_MEMORY_RECALL_MAX_ENTRIES,
  createChannelMemoryRecallIndex,
  selectRelevantChannelMemory,
  selectRelevantChannelMemoryFromIndex,
} from './channel-memory-recall.js';
import type { ChannelMemoryEntry } from './types.js';

function entry(id: string, text: string): ChannelMemoryEntry {
  return { id, text };
}

function longFact(text: string): string {
  return `${text} ${'z'.repeat(
    CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS + 1,
  )}`;
}

describe('selectRelevantChannelMemory', () => {
  it('reuses an immutable prepared index with equivalent selection', () => {
    const entries = [
      entry('fallback', 'short preference'),
      entry('relevant', longFact('deploy staging')),
    ];
    const index = createChannelMemoryRecallIndex(entries);

    expect(
      selectRelevantChannelMemoryFromIndex('deploy staging', index),
    ).toEqual(selectRelevantChannelMemory('deploy staging', entries));

    entries[0]!.text = 'changed after indexing';
    entries[1]!.text = 'production only';
    expect(
      selectRelevantChannelMemoryFromIndex('deploy staging', index),
    ).toEqual([
      entry('relevant', longFact('deploy staging')),
      entry('fallback', 'short preference'),
    ]);
  });

  it('matches NFKC-normalized, lowercased Latin terms', () => {
    const matching = entry('matching', longFact('deploy staging'));

    expect(
      selectRelevantChannelMemory('ＤＥＰＬＯＹ to STAGING', [matching]),
    ).toEqual([matching]);
  });

  it('does not score Latin or decimal terms shorter than two code points', () => {
    const shortTerms = entry('short', longFact('x 7'));
    const decimalTerm = entry('decimal', longFact('42'));

    expect(
      selectRelevantChannelMemory('x 7 42', [shortTerms, decimalTerm]),
    ).toEqual([decimalTerm]);
  });

  it.each([
    ['Han', '数据治理', '项目治理规范'],
    ['Hiragana', 'たのしい', 'うれしいこと'],
    ['Katakana', 'カタカナ', 'ナカナミ'],
    ['Hangul', '데이터관리', '품질관리자'],
  ])(
    'matches sliding adjacent bigrams within longer %s runs',
    (_script, message, fact) => {
      const matching = entry('matching', longFact(fact));

      expect(selectRelevantChannelMemory(message, [matching])).toEqual([
        matching,
      ]);
    },
  );

  it('does not score a single CJK character', () => {
    const singleCharacter = entry('single', longFact('数'));

    expect(selectRelevantChannelMemory('数', [singleCharacter])).toEqual([]);
  });

  it('includes Script_Extensions characters in Katakana bigram runs', () => {
    const matching = entry('matching', longFact('コーヒー'));

    expect(selectRelevantChannelMemory('コーヒー', [matching])).toEqual([
      matching,
    ]);
  });

  it('treats punctuation, whitespace, and unsafe invisibles as separators', () => {
    const joined = entry(
      'joined',
      longFact('deploytarget buildnext releasecandidate'),
    );
    const separated = entry(
      'separated',
      longFact('deploy target build next release candidate'),
    );

    expect(
      selectRelevantChannelMemory(
        'deploy,target\tbuild\u200bnext\u2028release-candidate',
        [joined, separated],
      ),
    ).toEqual([separated]);
  });

  it('ranks positive overlap by unique term count with stable ties', () => {
    const oneTerm = entry('one', longFact('alpha alpha alpha'));
    const firstTie = entry('first-tie', longFact('alpha beta'));
    const secondTie = entry('second-tie', longFact('beta gamma'));

    expect(
      selectRelevantChannelMemory('alpha alpha beta gamma', [
        oneTerm,
        firstTie,
        secondTie,
      ]),
    ).toEqual([firstTie, secondTie, oneTerm]);
  });

  it('places short no-overlap fallbacks after positives and excludes long ones', () => {
    const fallbackAtLimit = entry(
      'fallback',
      'x'.repeat(CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS),
    );
    const longUnrelated = entry(
      'long-unrelated',
      'y'.repeat(CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS + 1),
    );
    const positive = entry('positive', longFact('deploy'));

    expect(
      selectRelevantChannelMemory('deploy', [
        fallbackAtLimit,
        longUnrelated,
        positive,
      ]),
    ).toEqual([positive, fallbackAtLimit]);
  });

  it('measures fallback length after normalization by code point', () => {
    const normalizedAtLimit = entry(
      'at-limit',
      'ﬃ'.repeat(CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS / 3),
    );
    const normalizedOverLimit = entry(
      'over-limit',
      'ﬃ'.repeat(CHANNEL_MEMORY_RECALL_FALLBACK_CODE_POINTS / 3 + 1),
    );

    expect(
      selectRelevantChannelMemory('unrelated', [
        normalizedAtLimit,
        normalizedOverLimit,
      ]),
    ).toEqual([normalizedAtLimit]);
  });

  it('returns at most three entries', () => {
    const entries = [
      entry('one', 'fallback one'),
      entry('two', 'fallback two'),
      entry('three', 'fallback three'),
      entry('four', 'fallback four'),
    ];

    expect(selectRelevantChannelMemory('unrelated', entries)).toEqual(
      entries.slice(0, CHANNEL_MEMORY_RECALL_MAX_ENTRIES),
    );
  });

  it('skips entries that exceed the remaining fact-text budget and keeps later complete entries', () => {
    const first = entry('first', `aa ${'😀'.repeat(697)}`);
    const doesNotFit = entry('does-not-fit', `bb ${'😀'.repeat(498)}`);
    const laterFit = entry('later-fit', `cc ${'😀'.repeat(497)}`);

    expect(
      selectRelevantChannelMemory('aa bb cc', [first, doesNotFit, laterFit]),
    ).toEqual([first, laterFit]);
    expect(
      Array.from(first.text).length + Array.from(laterFit.text).length,
    ).toBe(CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS);
  });

  it('truncates a relevant entry that alone exceeds the fact-text budget', () => {
    const relevant = entry(
      'relevant',
      `deploy runbook ${'x'.repeat(CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS)}`,
    );

    const selected = selectRelevantChannelMemory('deploy', [relevant]);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(relevant.id);
    expect(selected[0]?.text).toMatch(/^deploy runbook/u);
    expect(selected[0]?.text).toMatch(/ \[truncated\]$/u);
    expect(Array.from(selected[0]?.text ?? '')).toHaveLength(
      CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS,
    );
    expect(relevant.text).not.toMatch(/\[truncated\]$/u);
  });

  it('does not truncate fitting entries or mutate the input array', () => {
    const fallback = Object.freeze(entry('fallback', 'short preference'));
    const relevant = Object.freeze(entry('relevant', longFact('deploy')));
    const entries = Object.freeze([fallback, relevant]);
    const before = [...entries];

    const selected = selectRelevantChannelMemory('deploy', entries);

    expect(selected).toEqual([relevant, fallback]);
    expect(selected[0]?.text).toBe(relevant.text);
    expect(entries).toEqual(before);
  });
});
