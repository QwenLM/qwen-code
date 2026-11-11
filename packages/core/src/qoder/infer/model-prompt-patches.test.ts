/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseModelPromptPatches } from './model-prompt-patches.js';

describe('parseModelPromptPatches', () => {
  it('validates and clones supported prompt patches', () => {
    expect(
      parseModelPromptPatches({
        g51: [
          {
            action: 'edit_system_prompt',
            content: 'Use the g51 prompt.',
            ignored: true,
          },
        ],
      }),
    ).toEqual({
      g51: [
        {
          action: 'edit_system_prompt',
          content: 'Use the g51 prompt.',
        },
      ],
    });
  });

  it('normalizes empty patch maps away', () => {
    expect(parseModelPromptPatches({})).toBeUndefined();
    expect(parseModelPromptPatches({ g51: [] })).toBeUndefined();
  });

  it.each([
    [null],
    [[]],
    [{ g51: 'not-an-array' }],
    [{ g51: [{ action: 'replace_tools', content: 'invalid' }] }],
    [{ g51: [{ action: 'edit_system_prompt', content: 1 }] }],
  ])('rejects invalid patch input: %j', (value) => {
    expect(() => parseModelPromptPatches(value)).toThrow(
      'invalid modelRequestPatches',
    );
  });
});
