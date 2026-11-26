/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { projectToolOutputReplacementToLlmContent } from './tool-output-replacement.js';

describe('tool output replacement', () => {
  it('projects Anthropic-compatible semantic blocks into GenAI model parts', () => {
    expect(
      projectToolOutputReplacementToLlmContent([
        { type: 'text', text: 'replacement text', _meta: { hidden: true } },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1hZ2U=',
          },
        },
      ]),
    ).toEqual([
      { text: 'replacement text' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ]);
  });

  it('keeps an empty semantic replacement empty for the later no-output mapper', () => {
    expect(projectToolOutputReplacementToLlmContent([])).toEqual([]);
  });
});
