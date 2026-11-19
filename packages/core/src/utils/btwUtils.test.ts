/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { buildBtwCacheSafeParams } from './btwUtils.js';

function configWithChat() {
  const chat = {
    getGenerationConfig: () => ({}),
    getHistory: vi.fn(() => [{ role: 'user', parts: [{ text: 'all' }] }]),
    getHistoryTail: vi.fn(() => [{ role: 'user', parts: [{ text: 'tail' }] }]),
  };
  const config = {
    getModel: () => 'qwen',
    getLlmClient: () => ({ getChat: () => chat }),
  } as unknown as Config;
  return { config, chat };
}

describe('buildBtwCacheSafeParams', () => {
  it('clones only the 40-entry tail by default', () => {
    const { config, chat } = configWithChat();

    const params = buildBtwCacheSafeParams(config);

    expect(chat.getHistoryTail).toHaveBeenCalledWith(40, true);
    expect(chat.getHistory).not.toHaveBeenCalled();
    expect(params?.history).toEqual([
      { role: 'user', parts: [{ text: 'tail' }] },
    ]);
  });

  it('clones the whole curated history when fullHistory is set', () => {
    const { config, chat } = configWithChat();

    const params = buildBtwCacheSafeParams(
      config,
      [{ question: 'q', response: 'a' }],
      { fullHistory: true },
    );

    expect(chat.getHistory).toHaveBeenCalledWith(true);
    expect(chat.getHistoryTail).not.toHaveBeenCalled();
    expect(params?.history).toEqual([
      { role: 'user', parts: [{ text: 'all' }] },
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'a' }] },
    ]);
  });
});
