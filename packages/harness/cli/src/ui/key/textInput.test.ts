/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Key } from '../contexts/KeypressContext.js';
import { isSingleLineTextInput } from './textInput.js';

function key(overrides: Partial<Key> = {}): Key {
  return {
    name: '',
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: true,
    sequence: 'query',
    ...overrides,
  };
}

describe('isSingleLineTextInput', () => {
  it('accepts ordinary multi-character and Unicode text chunks', () => {
    expect(isSingleLineTextInput(key({ sequence: 'sk-test-value' }))).toBe(
      true,
    );
    expect(isSingleLineTextInput(key({ sequence: '模型名称' }))).toBe(true);
  });

  it.each(['query\r', 'query\r\n', 'query\t', 'query\x7f', 'query\x85'])(
    'rejects a chunk containing control characters: %j',
    (sequence) => {
      expect(isSingleLineTextInput(key({ sequence }))).toBe(false);
    },
  );

  it('rejects empty, modified, or non-insertable input', () => {
    expect(isSingleLineTextInput(key({ sequence: '' }))).toBe(false);
    expect(isSingleLineTextInput(key({ insertable: false }))).toBe(false);
    expect(isSingleLineTextInput(key({ alt: true }))).toBe(false);
    expect(isSingleLineTextInput(key({ ctrl: true }))).toBe(false);
    expect(isSingleLineTextInput(key({ cmd: true }))).toBe(false);
  });
});
