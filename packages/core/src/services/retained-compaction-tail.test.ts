/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { findRetainedCompactionTail } from './retained-compaction-tail.js';
import { markApiHistoryPrompt } from '../utils/api-history-metadata.js';

const prefix: Content[] = [
  { role: 'user', parts: [{ text: 'Earlier task' }] },
  { role: 'model', parts: [{ text: 'Earlier response' }] },
  { role: 'user', parts: [{ text: 'Continue' }] },
];
const call = (id?: string): Content => ({
  role: 'model',
  parts: [{ functionCall: { id, name: 'edit', args: {} } }],
});
const result = (id?: string): Content => ({
  role: 'user',
  parts: [{ functionResponse: { id, name: 'edit', response: { ok: true } } }],
});

describe('findRetainedCompactionTail', () => {
  it('selects one response with all its following results and input', () => {
    const followup = { ...prefix[0] };
    markApiHistoryPrompt(followup, 'followup-prompt');
    expect(
      findRetainedCompactionTail([...prefix, call('a'), result('a'), followup]),
    ).toBe(3);
  });
  it.each([
    { role: 'user', parts: [{ text: 'Injected reminder.' }] },
    { role: 'user', parts: [] },
    {
      role: 'user',
      parts: [...result('a').parts!, { text: 'Unowned following input.' }],
    },
  ] as Content[])(
    'rejects following input without reliable ownership: %j',
    (entry) => {
      const tail = entry.parts?.some((part) => part.functionResponse)
        ? [call('a'), entry]
        : [call('a'), result('a'), entry];
      expect(findRetainedCompactionTail([...prefix, ...tail])).toBeUndefined();
    },
  );
  it('uses a pending result without changing stored history', () => {
    const history = [...prefix, call('a')];
    expect(findRetainedCompactionTail(history, result('a'))).toBe(3);
    expect(history).toHaveLength(4);
  });
  it('accepts an unambiguous no-ID pair', () => {
    expect(findRetainedCompactionTail([...prefix, call(), result()])).toBe(3);
  });
  it.each([
    [call('a')],
    [call('a'), result('b')],
    [call('a'), result('a'), result('a')],
    [call('a'), result()],
    [call(), result('a')],
    [
      { role: 'model', parts: [...call().parts!, ...call().parts!] },
      result(),
      result(),
    ],
    [{ role: 'model', parts: [{ text: 'Done' }] }, result('earlier')],
  ] as Content[][])(
    'falls back for incomplete or ambiguous tools: %j',
    (...tail) => {
      expect(findRetainedCompactionTail([...prefix, ...tail])).toBeUndefined();
    },
  );
  it('requires earlier progress rather than just a summary acknowledgment', () => {
    const synthetic = {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    };
    expect(
      findRetainedCompactionTail([
        prefix[0],
        synthetic,
        prefix[2],
        call('a'),
        result('a'),
      ]),
    ).toBeUndefined();
    expect(findRetainedCompactionTail([...prefix, synthetic])).toBeUndefined();
  });
  it('does not preserve a first response or thought-only partial', () => {
    expect(
      findRetainedCompactionTail([prefix[0], call('a'), result('a')]),
    ).toBeUndefined();
    expect(
      findRetainedCompactionTail([
        ...prefix,
        { role: 'model', parts: [{ text: 'thinking', thought: true }] },
      ]),
    ).toBeUndefined();
  });
});
