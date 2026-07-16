/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { buildBtwCacheSafeParams } from './btwUtils.js';

describe('buildBtwCacheSafeParams', () => {
  it('replaces media before handing live history to a forked model', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'raw-image' } },
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'loaded' },
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: 'raw-tool-image',
                  },
                },
              ],
            },
          },
        ],
      } as unknown as Content,
      { role: 'model', parts: [{ text: 'done' }] },
    ];
    const config = {
      getGeminiClient: vi.fn(() => ({
        getChat: vi.fn(() => ({
          getGenerationConfig: vi.fn(() => ({ temperature: 0 })),
        })),
        getHistoryTail: vi.fn(() => history),
      })),
      getModel: vi.fn(() => 'text-primary'),
    } as unknown as Config;

    const result = buildBtwCacheSafeParams(config);

    const serialized = JSON.stringify(result?.history);
    expect(serialized).toContain('[image: image/png]');
    expect(serialized).toContain('[image: image/jpeg]');
    expect(serialized).not.toContain('raw-image');
    expect(serialized).not.toContain('raw-tool-image');
    expect(JSON.stringify(history)).toContain('raw-tool-image');
  });
});
