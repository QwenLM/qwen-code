/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import { markTypedPrompt } from '@qwen-code/qwen-code-core';
import {
  MID_TURN_INTERRUPT_USER_MESSAGE_PREFIX,
  MID_TURN_USER_MESSAGE_PREFIX,
  prefixMidTurnUserMessageParts,
} from './midTurnUserMessage.js';

describe('prefixMidTurnUserMessageParts', () => {
  it('returns a text-only part when parts normalize to empty', () => {
    expect(prefixMidTurnUserMessageParts([], 'fallback')).toEqual([
      markTypedPrompt({ text: `${MID_TURN_USER_MESSAGE_PREFIX}fallback` }),
    ]);
  });

  it('prepends the prefix to the first text part', () => {
    const parts: Part[] = [{ text: 'hello' }, { text: 'world' }];

    expect(prefixMidTurnUserMessageParts(parts, 'hello')).toEqual([
      { text: `${MID_TURN_USER_MESSAGE_PREFIX}hello` },
      { text: 'world' },
    ]);
  });

  it('prepends a text prefix before non-text first parts', () => {
    const imagePart: Part = {
      inlineData: { mimeType: 'image/png', data: 'abc' },
    };

    expect(prefixMidTurnUserMessageParts([imagePart], 'inspect this')).toEqual([
      markTypedPrompt({ text: `${MID_TURN_USER_MESSAGE_PREFIX}inspect this` }),
      imagePart,
    ]);
  });

  it('leaves the text it adds unmarked when a part already holds the typed prompt', () => {
    // The marked part already carries what the user typed; marking the
    // added copy too would quote it twice after compaction.
    const imagePart: Part = {
      inlineData: { mimeType: 'image/png', data: 'abc' },
    };
    const typed = markTypedPrompt({ text: 'inspect this' });

    expect(
      prefixMidTurnUserMessageParts([imagePart, typed], 'inspect this'),
    ).toEqual([
      { text: `${MID_TURN_USER_MESSAGE_PREFIX}inspect this` },
      imagePart,
      typed,
    ]);
  });

  it('keeps the mark on a marked first text part it prefixes', () => {
    expect(
      prefixMidTurnUserMessageParts(
        [markTypedPrompt({ text: 'hello' })],
        'hello',
      ),
    ).toEqual([
      markTypedPrompt({ text: `${MID_TURN_USER_MESSAGE_PREFIX}hello` }),
    ]);
  });

  it('uses the given prefix instead of the default', () => {
    expect(
      prefixMidTurnUserMessageParts(
        [{ text: 'stop' }],
        'stop',
        MID_TURN_INTERRUPT_USER_MESSAGE_PREFIX,
      ),
    ).toEqual([{ text: `${MID_TURN_INTERRUPT_USER_MESSAGE_PREFIX}stop` }]);
  });
});
