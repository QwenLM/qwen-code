/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { LlmChat } from '../core/llm-chat.js';
import { getAutoMemorySnapshot } from '../memory/request-context.js';
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../core/environmentContext.js';
import { generateSessionRecap } from './sessionRecap.js';
import { content } from '../test-utils/model-fixtures.js';

const reminder = (body: string) =>
  `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`;

describe('generateSessionRecap', () => {
  it.each(['CATALOG_SENTINEL', ''])(
    'omits catalog metadata while preserving raw dialog boundaries, catalog=%j',
    async (catalog) => {
      const first = content('user', { text: 'First parser request' });
      const second = content('user', { text: 'Second parser request' });
      const answer = content('model', { text: 'Fixed parser' });
      const history = [
        content(
          'user',
          ...first.parts!,
          getAutoMemorySnapshot([], 'CATALOG_SENTINEL')!,
        ),
        content('model', { text: '' }),
        second,
        answer,
      ];
      const original = structuredClone(history);
      const chat = new LlmChat(
        { getAutoMemoryContext: () => catalog } as Config,
        {},
        history,
      );
      const generateText = vi.fn(async (_opts: { contents: Content[] }) => ({
        text: '<recap>Fixing parser.</recap>',
        usage: undefined,
      }));
      const config = {
        getFastModel: () => 'qwen-turbo',
        getModel: () => 'qwen-plus',
        getLlmClient: () => chat,
        getBaseLlmClient: () => ({ generateText }),
        getOutputLanguageFilePath: () => undefined,
      } as unknown as Config;
      expect(
        await generateSessionRecap(config, new AbortController().signal),
      ).toBe('Fixing parser.');
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0][0].contents.slice(0, -1)).toEqual([
        first,
        second,
        answer,
      ]);
      expect(chat.getHistoryShallow()).toEqual(original);
    },
  );

  it('strips startup and mid-session system reminders from recap input', async () => {
    const history: Content[] = [
      content(
        'user',
        { text: reminder('STARTUP_SKILL_LIST') },
        { text: 'fix session title pollution' },
      ),
      { role: 'model', parts: [{ text: 'I found the title service.' }] },
      { role: 'user', parts: [{ text: reminder('ADDED_MCP_TOOLS') }] },
      content(
        'user',
        { text: reminder('PLAN_MODE_REMINDER') },
        {
          text: `continue with recap coverage\n${reminder('IDE_CONTEXT')}`,
        },
      ),
    ];

    let captured: Content[] | null = null;
    let capturedConfig: Record<string, unknown> | undefined;
    const generateText = vi.fn(
      async (opts: {
        contents: Content[];
        config?: Record<string, unknown>;
      }) => {
        captured = opts.contents;
        capturedConfig = opts.config;
        return {
          text: '<recap>Fixing session title pollution. Next: verify tests.</recap>',
          usage: undefined,
        };
      },
    );
    const config = {
      getFastModel: vi.fn(() => 'qwen-turbo'),
      getModel: vi.fn(() => 'qwen-plus'),
      getLlmClient: vi.fn(() => ({
        getHistoryShallow: () => history,
      })),
      getBaseLlmClient: vi.fn(() => ({ generateText })),
      getOutputLanguageFilePath: vi.fn(() => undefined),
    } as unknown as Config;

    const result = await generateSessionRecap(
      config,
      new AbortController().signal,
    );

    expect(result).toBe('Fixing session title pollution. Next: verify tests.');
    expect(captured).not.toBeNull();
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('STARTUP_SKILL_LIST');
    expect(serialized).not.toContain('ADDED_MCP_TOOLS');
    expect(serialized).not.toContain('PLAN_MODE_REMINDER');
    expect(serialized).not.toContain('IDE_CONTEXT');
    expect(serialized).toContain('fix session title pollution');
    expect(serialized).toContain('continue with recap coverage');
    // #12928: no hard-coded temperature reaches the recap wire.
    expect(capturedConfig).not.toHaveProperty('temperature');
  });
});
