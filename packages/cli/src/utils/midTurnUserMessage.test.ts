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
  it('prepends a text prefix before non-text first parts', () => {
    const imagePart: Part = {
      inlineData: { mimeType: 'image/png', data: 'abc' },
    };

    expect(
      prefixMidTurnUserMessageParts([imagePart], 'inspect this'),
    ).toEqual([
      { text: `${MID_TURN_USER_MESSAGE_PREFIX}inspect this` },
      imagePart,
    ]);
  });
});
