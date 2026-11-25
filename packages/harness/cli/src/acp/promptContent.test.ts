/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BRAND_NAME, type Config } from '@qwen-code/core';
import { resolveAcpPromptContent } from './acpPromptContent.js';
import { partsToContentBlocks } from './promptContent.js';

it('identifies the selected runtime when rejecting ACP audio prompts', async () => {
  await expect(
    resolveAcpPromptContent({
      message: [{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' }],
      signal: new AbortController().signal,
      config: {} as Config,
      sendUpdate: vi.fn(),
      requestPermission: vi.fn(),
    }),
  ).rejects.toThrow(`Audio prompts are not supported by the selected ${BRAND_NAME} runtime.`);
});

describe('partsToContentBlocks', () => {
  it('keeps supported raster image data as an image block', () => {
    expect(
      partsToContentBlocks([
        { inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } },
      ]),
    ).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
    ]);
  });

  it('represents SVG image data as an unsupported-image warning', () => {
    expect(
      partsToContentBlocks([
        { inlineData: { data: 'PHN2Zz4=', mimeType: 'image/svg+xml' } },
      ]),
    ).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
      },
    ]);
  });
});
