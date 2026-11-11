/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isMalformedToolUseCompletion } from './completion-integrity.js';

describe('isMalformedToolUseCompletion', () => {
  it('detects tool_use without a structured tool block', () => {
    expect(
      isMalformedToolUseCompletion({
        stopReason: 'tool_use',
        blocks: [{ type: 'text', text: '<invoke name="read_file">' }],
      }),
    ).toBe(true);
    expect(
      isMalformedToolUseCompletion({
        stopReason: 'tool_use',
        blocks: [],
      }),
    ).toBe(true);
  });

  it('accepts a structured tool block and ordinary completions', () => {
    expect(
      isMalformedToolUseCompletion({
        stopReason: 'tool_use',
        blocks: [
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} },
        ],
      }),
    ).toBe(false);
    expect(
      isMalformedToolUseCompletion({
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'done' }],
      }),
    ).toBe(false);
  });
});
