/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TerminalOutputBuffer } from './terminalOutputBuffer.js';

describe('TerminalOutputBuffer', () => {
  it('keeps full output below the max size', () => {
    const buffer = new TerminalOutputBuffer(20);

    buffer.append('hello');
    buffer.append(' world');

    expect(buffer.toString()).toBe('hello world');
    expect(buffer.tailText()).toBe('hello world');
  });

  it('keeps head and tail when output exceeds the max size', () => {
    const buffer = new TerminalOutputBuffer(10);

    buffer.append('abcdefghij12345');

    expect(buffer.toString()).toBe(
      'abcde\n[... 5 characters omitted ...]\n12345',
    );
  });

  it('returns a bounded tail view', () => {
    const buffer = new TerminalOutputBuffer(100);

    buffer.append('0123456789');

    expect(buffer.tailText(4)).toBe('6789');
  });
});
