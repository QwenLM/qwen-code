/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_TRUSTED_USER_ANSWER_CALLS,
  MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS,
  MAX_TRUSTED_USER_ANSWERS_TOTAL_CHARS,
  TrustedUserAnswers,
  normalizeTrustedUserAnswers,
} from './trusted-user-answers.js';

/**
 * Shaped like the built-in tool's `Question`; the store reads only `question`,
 * so both hosts can forward their confirmation details unchanged.
 */
const questions = [
  {
    question: 'Create the marker?',
    header: 'Marker',
    options: [
      { label: 'Yes', description: 'Only create /tmp/marker.' },
      { label: 'No', description: 'Do not create it.' },
    ],
  },
];

describe('normalizeTrustedUserAnswers', () => {
  it('keeps the exact answer without the model-authored option context', () => {
    expect(normalizeTrustedUserAnswers(questions, { '0': 'No' })).toEqual([
      { question: 'Create the marker?', answer: 'No' },
    ]);
  });

  it('keeps non-empty custom input', () => {
    expect(
      normalizeTrustedUserAnswers(questions, {
        '0': 'Yes, but only after tests pass',
      }),
    ).toEqual([
      {
        question: 'Create the marker?',
        answer: 'Yes, but only after tests pass',
      },
    ]);
  });

  it('caps the model-authored question text', () => {
    const long = 'q'.repeat(MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS + 50);
    const [answer] = normalizeTrustedUserAnswers([{ question: long }], {
      '0': 'Yes',
    });
    expect(answer!.question).toBe(
      long.slice(0, MAX_TRUSTED_USER_ANSWER_QUESTION_CHARS) + '…',
    );
    expect(answer!.answer).toBe('Yes');
  });

  it('rejects malformed, out-of-range, empty, and non-string answers', () => {
    expect(
      normalizeTrustedUserAnswers(questions, {
        '00': 'Yes',
        '1': 'Yes',
        '0': '   ',
        '-1': 'No',
        x: 42,
      }),
    ).toEqual([]);
  });

  it('rejects a missing, null, array, or empty payload', () => {
    expect(normalizeTrustedUserAnswers(questions, undefined)).toEqual([]);
    expect(normalizeTrustedUserAnswers(questions, null)).toEqual([]);
    expect(normalizeTrustedUserAnswers(questions, [{ '0': 'Yes' }])).toEqual(
      [],
    );
    expect(normalizeTrustedUserAnswers(questions, {})).toEqual([]);
  });
});

describe('TrustedUserAnswers', () => {
  it('rejects an empty call id and keeps stores isolated', () => {
    const first = new TrustedUserAnswers();
    const second = new TrustedUserAnswers();

    expect(first.record('', questions, { '0': 'Yes' })).toBe(false);
    expect(first.record('call-1', questions, { '0': 'Yes' })).toBe(true);
    expect(second.snapshot()).toEqual([]);
  });

  it('rejects a payload the normalizer drops', () => {
    const store = new TrustedUserAnswers();

    expect(store.record('call-1', questions, undefined)).toBe(false);
    expect(store.record('call-1', questions, [{ '0': 'Yes' }])).toBe(false);
    expect(store.record('call-1', questions, {})).toBe(false);
    expect(store.record('call-1', questions, { '9': 'Yes' })).toBe(false);

    expect(store.snapshot()).toEqual([]);
  });

  it('does not overwrite an accepted call and snapshots by value', () => {
    const store = new TrustedUserAnswers();
    const mutableQuestions = structuredClone(questions);
    expect(store.record('call-1', mutableQuestions, { '0': 'Yes' })).toBe(true);
    expect(store.record('call-1', mutableQuestions, { '0': 'No' })).toBe(false);

    const snapshot = store.snapshot();
    mutableQuestions[0]!.question = 'mutated';
    mutableQuestions[0]!.options[0]!.description = 'mutated';

    expect(snapshot).toEqual([
      {
        callId: 'call-1',
        answers: [{ question: 'Create the marker?', answer: 'Yes' }],
        omitted: false,
      },
    ]);
  });

  it('omits an oversized conditional answer as a complete unit', () => {
    const store = new TrustedUserAnswers();
    expect(
      store.record('call-long', questions, {
        '0': `Yes ${'only under this condition '.repeat(500)}`,
      }),
    ).toBe(true);
    expect(store.snapshot()).toEqual([
      { callId: 'call-long', answers: [], omitted: true },
    ]);
  });

  it('keeps only the most recent bounded calls and clears them', () => {
    const store = new TrustedUserAnswers();
    for (let i = 0; i < MAX_TRUSTED_USER_ANSWER_CALLS + 2; i++) {
      store.record(`call-${i}`, questions, { '0': 'Yes' });
    }
    expect(store.snapshot().map((record) => record.callId)).toEqual(
      Array.from(
        { length: MAX_TRUSTED_USER_ANSWER_CALLS },
        (_, index) => `call-${index + 2}`,
      ),
    );
    store.clear();
    expect(store.snapshot()).toEqual([]);
  });

  it('evicts oldest complete records at the total character limit', () => {
    const store = new TrustedUserAnswers();
    const answer = 'x'.repeat(
      Math.floor(MAX_TRUSTED_USER_ANSWERS_TOTAL_CHARS / 5),
    );
    for (let i = 0; i < 5; i++) {
      expect(store.record(`call-${i}`, questions, { '0': answer })).toBe(true);
    }

    expect(store.snapshot().map((record) => record.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4',
    ]);
  });
});
