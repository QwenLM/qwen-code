/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from '@qwen-code/qwen-code-core/mods/runtime.js';
import type {
  ModModelCompleteInput,
  ModModelCompleteResult,
  ModLog,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type {
  ModAssistantMessageInput,
  ModThinkingInput,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  displayTranslationPlugin,
  displayTranslationTarget,
  drawsTranslatedRows,
  modsWanted,
  type DisplayTranslationTarget,
} from './display-translation-mod.js';

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const END = '\n[QWEN_DISPLAY_END]';

const settings = (general: unknown, experimental: unknown = {}) =>
  ({ merged: { general, experimental } }) as unknown as LoadedSettings;

describe('display translation settings', () => {
  it('reads the two targets and nothing else', () => {
    expect(
      displayTranslationTarget(settings({ displayLanguage: 'zh-CN' })),
    ).toBe('zh-CN');
    expect(displayTranslationTarget(settings({ displayLanguage: 'en' }))).toBe(
      'en',
    );
    for (const displayLanguage of ['off', 'fr', 'zh', undefined])
      expect(
        displayTranslationTarget(settings({ displayLanguage })),
      ).toBeUndefined();
    expect(displayTranslationTarget(settings(undefined))).toBeUndefined();
  });

  it('wants Mods for either switch', () => {
    expect(modsWanted(settings({}, { mods: true }))).toBe(true);
    expect(modsWanted(settings({ displayLanguage: 'en' }))).toBe(true);
    expect(modsWanted(settings({ displayLanguage: 'off' }))).toBe(false);
  });

  it('applies to hosts that draw reply or thinking rows', () => {
    expect(drawsTranslatedRows(['AbovePrompt', 'Thinking'])).toBe(true);
    expect(drawsTranslatedRows(['AssistantMessage'])).toBe(true);
    expect(drawsTranslatedRows(['AbovePrompt'])).toBe(false);
  });
});

describe('the built-in display translation Mod', () => {
  const runtimes: ModRuntime[] = [];
  const logs: ModLog[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    logs.length = 0;
  });

  async function create(
    target: DisplayTranslationTarget,
    answer: (input: ModModelCompleteInput) => ModModelCompleteResult = (
      input,
    ) => ({
      isAnswered: true,
      text: `[${input.prompt}]${END}\n`,
      usage,
    }),
  ) {
    const complete = vi.fn(async (input: ModModelCompleteInput) =>
      answer(input),
    );
    const runtime = await ModRuntime.createGroup(
      [displayTranslationPlugin(target)],
      '/workspace',
      (log) => logs.push(log),
      new AbortController().signal,
      undefined,
      'desktop',
      '1.0.0',
      undefined,
      undefined,
      { sites: ['AssistantMessage', 'Thinking'], invalidate: () => {} },
      false,
      undefined,
      complete,
    );
    runtimes.push(runtime);
    const drawn = async (input: ModAssistantMessageInput | ModThinkingInput) =>
      (
        (await runtime.render(input, new AbortController().signal)).props as
          | { text?: string }
          | undefined
      )?.text;
    const reply = (text: string) =>
      drawn({
        surface: 'desktop',
        component: 'AssistantMessage',
        requestId: '1',
        props: { text, isFirstOfReply: true },
      });
    const thought = (text: string) =>
      drawn({
        surface: 'desktop',
        component: 'Thinking',
        requestId: '2',
        props: { text },
      });
    return { complete, reply, thought };
  }

  it('translates English into Simplified Chinese with the fast model', async () => {
    const { complete, reply, thought } = await create('zh-CN');
    await expect(reply('Run the tests.')).resolves.toBe('[Run the tests.]');
    await expect(thought('Check the file first.')).resolves.toBe(
      '[Check the file first.]',
    );
    expect(complete).toHaveBeenCalledTimes(2);
    const request = complete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'haiku',
      prompt: 'Run the tests.',
      maxTokens: 8192,
      timeoutMs: 25000,
    });
    expect(request.effort).toBeUndefined();
    expect(request.system).toContain('into Simplified Chinese');
    expect(request.system).toMatch(
      /followed by this exact line:\n\[QWEN_DISPLAY_END\]$/,
    );
  });

  it('leaves Chinese, code-only and empty prose alone for a Chinese target', async () => {
    const { complete, reply } = await create('zh-CN');
    // Han characters against Latin words: two English words, four characters.
    for (const text of [
      '把 useState 换成 useReducer',
      '```ts\nconst answer = 42;\n```\n`npm test`',
      '~~~~sh\nnpm run build\n~~~~~\n`npm test`',
      '    const answer = 42;\n\n\treturn answer;',
      '42 → 43',
    ])
      await expect(reply(text)).resolves.toBe(text);
    expect(complete).not.toHaveBeenCalled();
  });

  it('judges a block on its prose, without its code', async () => {
    const { complete, reply } = await create('zh-CN');
    await expect(
      reply('Use `这是一个很长的中文标识符` here.\n```\n中文注释中文注释\n```'),
    ).resolves.toMatch(/^\[Use/);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('translates Chinese into English and leaves English alone', async () => {
    const { complete, reply, thought } = await create('en');
    await expect(thought('先看看这个文件。')).resolves.toBe(
      '[先看看这个文件。]',
    );
    await expect(reply('Run the tests.')).resolves.toBe('Run the tests.');
    await expect(reply('`git status`')).resolves.toBe('`git status`');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].system).toContain('into English');
  });

  it('keeps the original when the call is not answered, answers nothing or is cut off', async () => {
    const unanswered = await create('zh-CN', () => ({
      isAnswered: false,
      reason: 'aborted',
      usage,
    }));
    await expect(unanswered.reply('Run the tests.')).resolves.toBe(
      'Run the tests.',
    );
    const blank = await create('zh-CN', () => ({
      isAnswered: true,
      text: ` \n${END}`,
      usage,
    }));
    await expect(blank.reply('Run the tests.')).resolves.toBe('Run the tests.');
    // Without its end line, or cut to its head and tail by the host.
    for (const text of [
      '运行测试。',
      `运行\n[... truncated for Mods ...]\n测试。${END}`,
    ]) {
      const cut = await create('zh-CN', () => ({
        isAnswered: true,
        text,
        usage,
      }));
      await expect(cut.reply('Run the tests.')).resolves.toBe('Run the tests.');
    }
    expect(logs.map((log) => log.text)).toEqual([
      'Left untranslated: aborted',
      'Left untranslated: empty answer',
      'Left untranslated: incomplete answer',
      'Left untranslated: incomplete answer',
    ]);
    expect(logs.every((log) => log.to === 'debug')).toBe(true);
  });

  it('drops carriage returns from the translation', async () => {
    const { reply } = await create('zh-CN', () => ({
      isAnswered: true,
      text: `第一行\r\n第二行\r${END}`,
      usage,
    }));
    await expect(reply('First line.\nSecond line.')).resolves.toBe(
      '第一行\n第二行',
    );
  });
});
