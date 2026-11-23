/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ModModelCompleteInput,
  ModModelCompleteResult,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  displayTranslationTarget,
  drawsTranslatedRows,
  modsWanted,
  translateDisplayText,
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
    for (const displayLanguage of ['off', 'fr', 'zh', undefined]) {
      expect(
        displayTranslationTarget(settings({ displayLanguage })),
      ).toBeUndefined();
    }
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

describe('translateDisplayText', () => {
  const signal = new AbortController().signal;
  const answered = (text: string): ModModelCompleteResult => ({
    isAnswered: true,
    text,
    usage,
  });
  const answer = (translated: string) =>
    vi.fn(async (_input: ModModelCompleteInput, _signal: AbortSignal) =>
      answered(translated + END),
    );

  it('translates English into Simplified Chinese with the fast model', async () => {
    const complete = answer('运行测试。');
    await expect(
      translateDisplayText('Run the tests.', 'zh-CN', complete, signal),
    ).resolves.toBe('运行测试。');
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      {
        model: 'haiku',
        prompt: 'Run the tests.',
        maxTokens: 8192,
        timeoutMs: 25000,
        system: expect.stringMatching(
          /into Simplified Chinese.*followed by this exact line:\n\[QWEN_DISPLAY_END\]$/,
        ),
      },
      signal,
    );
  });

  it('skips Simplified Chinese, code-only Markdown and empty prose', async () => {
    const complete = answer('运行测试。');
    for (const text of [
      '把 useState 换成 useReducer',
      '```ts\nconst answer = 42;\n```\n`npm test`',
      '~~~~sh\nnpm run build\n~~~~~\n`npm test`',
      '    const answer = 42;\n\n\treturn answer;',
      '> ~~~sh\n> npm test\n> ~~~',
      '``long `inline` example``',
      '~~~sh\nnpm test',
      '42 → 43',
    ]) {
      await expect(
        translateDisplayText(text, 'zh-CN', complete, signal),
      ).resolves.toBeUndefined();
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('classifies prose independently from indented, fenced and inline code', async () => {
    const code =
      '\n\n    # 测试运行情况以及输出内容\n    npm test' +
      '\n\n~~~sh\n# 中文注释中文注释\nnpm test\n~~~';
    const inline = '``这是一个`很长`的中文标识符``';
    const original = 'Use ' + inline + ' here.' + code;
    const translated = '在这里使用 ' + inline + '。' + code;
    const complete = answer(translated);
    await expect(
      translateDisplayText(original, 'zh-CN', complete, signal),
    ).resolves.toBe(translated);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('translates Traditional Chinese when the target is Simplified Chinese', async () => {
    const complete = answer('请先确认这个文件是否存在。');
    await expect(
      translateDisplayText(
        '請先確認這個檔案是否存在。',
        'zh-CN',
        complete,
        signal,
      ),
    ).resolves.toBe('请先确认这个文件是否存在。');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('translates Chinese into English and leaves English alone', async () => {
    const complete = answer('Check this file first.');
    await expect(
      translateDisplayText('先看看这个文件。', 'en', complete, signal),
    ).resolves.toBe('Check this file first.');
    await expect(
      translateDisplayText('Run the tests.', 'en', complete, signal),
    ).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].system).toContain('into English');
  });

  it('does not confuse prose in another script with an empty block', async () => {
    await expect(
      translateDisplayText(
        'Запустите тесты.',
        'en',
        answer('Run the tests.'),
        signal,
      ),
    ).resolves.toBe('Run the tests.');
  });

  it.each([
    [
      'Run the command.\n\n~~~sh\nnpm test\n~~~',
      '运行命令。\n\n~~~sh\nnpm run build\n~~~',
    ],
    ['Run `npm test`.', '运行 `npm run build`。'],
    ['Run this.\n\n    npm test', '运行这个。\n\n    npm run build'],
    ['Run this.\n\n> ~~~sh\n> npm test\n> ~~~', '运行这个。'],
    ['Run the command.', '运行命令。\n\n~~~sh\nnpm run build\n~~~'],
    [
      'Use the command.\n\n| Command |\n| --- |\n| `test\\|run` |',
      '使用以下命令。\n\n| 命令 |\n| --- |\n| `test\\|build` |',
    ],
  ])(
    'keeps the original when the translation changes code in %s',
    async (original, translated) => {
      await expect(
        translateDisplayText(original, 'zh-CN', answer(translated), signal),
      ).resolves.toBeUndefined();
    },
  );

  it('keeps the original when the call is unanswered or throws', async () => {
    const unanswered: ModModelCompleteResult = {
      isAnswered: false,
      reason: 'aborted',
      usage,
    };
    await expect(
      translateDisplayText(
        'Run the tests.',
        'zh-CN',
        async () => unanswered,
        signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      translateDisplayText(
        'Run the tests.',
        'zh-CN',
        vi.fn().mockRejectedValue(new Error('No configured model')),
        signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps the original on an empty or incomplete translation', async () => {
    for (const text of [
      ' \n' + END,
      '运行测试。',
      '运行\n[... truncated for Mods ...]\n测试。' + END,
    ]) {
      await expect(
        translateDisplayText(
          'Run the tests.',
          'zh-CN',
          async () => answered(text),
          signal,
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('ignores a successful answer that arrives after cancellation', async () => {
    const controller = new AbortController();
    await expect(
      translateDisplayText(
        'Run the tests.',
        'zh-CN',
        async () => {
          controller.abort();
          return answered('运行测试。' + END);
        },
        controller.signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('drops carriage returns from the translation', async () => {
    await expect(
      translateDisplayText(
        'First line.\nSecond line.',
        'zh-CN',
        answer('第一行\r\n第二行\r'),
        signal,
      ),
    ).resolves.toBe('第一行\n第二行');
  });
});
