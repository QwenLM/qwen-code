/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildPromptBlocks } from './acpPromptBuilder.js';

describe('buildPromptBlocks', () => {
  it('builds ACP resource_link blocks from saved image attachments', () => {
    expect(
      buildPromptBlocks('Please inspect this screenshot.', [
        {
          path: '/tmp/My Images/pasted image.png',
          name: 'pasted image.png',
          mimeType: 'image/png',
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'Please inspect this screenshot.' },
      {
        type: 'resource_link',
        name: 'pasted image.png',
        mimeType: 'image/png',
        uri: 'file:///tmp/My Images/pasted image.png',
      },
    ]);
  });

  it('returns only resource links when the prompt has images only', () => {
    expect(
      buildPromptBlocks('', [
        {
          path: '/tmp/clipboard/pasted.webp',
          name: 'pasted.webp',
          mimeType: 'image/webp',
        },
      ]),
    ).toEqual([
      {
        type: 'resource_link',
        name: 'pasted.webp',
        mimeType: 'image/webp',
        uri: 'file:///tmp/clipboard/pasted.webp',
      },
    ]);
  });
});
