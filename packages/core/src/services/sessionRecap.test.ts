/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../utils/environmentContext.js';
import { generateSessionRecap } from './sessionRecap.js';

const reminder = (body: string) =>
  `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`;

describe('generateSessionRecap', () => {
  it('strips startup and mid-session system reminders from recap input', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: reminder('STARTUP_SKILL_LIST') }] },
      { role: 'user', parts: [{ text: 'fix session title pollution' }] },
      { role: 'model', parts: [{ text: 'I found the title service.' }] },
      { role: 'user', parts: [{ text: reminder('ADDED_MCP_TOOLS') }] },
      {
        role: 'user',
        parts: [
          { text: reminder('PLAN_MODE_REMINDER') },
          {
            text: `continue with recap coverage\n${reminder('IDE_CONTEXT')}`,
          },
        ],
      },
    ];

    let captured: Content[] | null = null;
    const generateText = vi.fn(async (opts: { contents: Content[] }) => {
      captured = opts.contents;
      return {
        text: '<recap>Fixing session title pollution. Next: verify tests.</recap>',
        usage: undefined,
      };
    });
    const config = {
      getFastModel: vi.fn(() => 'qwen-turbo'),
      getModel: vi.fn(() => 'qwen-plus'),
      getGeminiClient: vi.fn(() => ({
        getHistoryShallow: () => history,
      })),
      getBaseLlmClient: vi.fn(() => ({ generateText })),
      getOutputLanguageFilePath: vi.fn(() => undefined),
    } as unknown as Config;

    const result = await generateSessionRecap(
      config,
      new AbortController().signal,
    );

    expect(result).toBe(
      'Fixing session title pollution. Next: verify tests.',
    );
    expect(captured).not.toBeNull();
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('STARTUP_SKILL_LIST');
    expect(serialized).not.toContain('ADDED_MCP_TOOLS');
    expect(serialized).not.toContain('PLAN_MODE_REMINDER');
    expect(serialized).not.toContain('IDE_CONTEXT');
    expect(serialized).toContain('fix session title pollution');
    expect(serialized).toContain('continue with recap coverage');
  });
});
