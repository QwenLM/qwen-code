/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { LlmChat } from '../core/llm-chat.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';
import {
  setModelToolErrorNote,
  withModelToolErrorNotes,
} from '../tools/tool-error.js';
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
  it.each([true, false])(
    'preserves the parent model diagnostic in memory (fullHistory: %s)',
    (fullHistory) => {
      const config = {
        getModel: () => 'qwen',
        getLlmClient: () => ({ getChat: () => chat }),
      } as unknown as Config;
      const result = fnResponse(
        'list_directory',
        { error: 'must be array' },
        'call',
      );
      const note = '; fix the JSON syntax';
      setModelToolErrorNote(result, note);
      const history = [
        userText('list files'),
        content('model', fnCall('list_directory', { ignore: '[1,]' }, 'call')),
        content('user', result),
        modelText('done'),
      ];
      const chat = new LlmChat(config, {}, history);
      const snapshot = buildBtwCacheSafeParams(config, [], { fullHistory })!;

      const parentRequest = withModelToolErrorNotes(history);
      expect(
        parentRequest[2].parts?.[0].functionResponse?.response?.['error'],
      ).toBe('must be array' + note);
      expect(withModelToolErrorNotes(snapshot.history)).toEqual(parentRequest);
      expect(
        snapshot.history[2].parts?.[0].functionResponse?.response,
      ).not.toBe(result.functionResponse?.response);
      expect(JSON.stringify(snapshot)).not.toContain(note);
    },
  );

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
