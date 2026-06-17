/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  MID_TURN_USER_MESSAGE_PREFIX,
  prefixMidTurnUserMessageParts,
} from './midTurnUserMessage.js';

describe('prefixMidTurnUserMessageParts', () => {
  it('returns a text-only part when parts normalize to empty', () => {
    expect(prefixMidTurnUserMessageParts([], 'fallback')).toEqual([
      { text: `${MID_TURN_USER_MESSAGE_PREFIX}fallback` },
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
      { text: `${MID_TURN_USER_MESSAGE_PREFIX}inspect this` },
      imagePart,
    ]);
  });
});
