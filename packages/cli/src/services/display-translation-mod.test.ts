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

  it('accepts a translation that reorders inline code and links', async () => {
    const original =
      'Set `x` in `config.json`, see [docs](https://a.example) and [api](https://b.example).';
    const translated =
      '在 `config.json` 中设置 `x`，参见 [接口](https://b.example) 和 [文档](https://a.example)。';
    await expect(
      translateDisplayText(original, 'zh-CN', answer(translated), signal),
    ).resolves.toBe(translated);
  });

  it.each([
    [
      'See https://a.example/docs.',
      '详见 https://a.example/docs。',
      '详见 https://a.example/docs 。',
    ],
    [
      'Visit https://a.example/docs,\nthen run it.',
      '请访问 https://a.example/docs，\n然后运行。',
      '请访问 https://a.example/docs ，\n然后运行。',
    ],
    ['Open <foo:bar>.', '打开 <foo:bar>。'],
    [
      '详细的使用说明请参见 https://a.example/docs。',
      'See https://a.example/docs for details.',
    ],
    ['Mail a@b.example.', '发邮件到 a@b.example。'],
    [
      'See https://a.example.',
      '详见 https://a.example。',
      '详见 https://a.example 。',
    ],
    [
      'See the docs at https://例子.测试.',
      '文档详见 https://例子.测试。',
      '文档详见 https://例子.测试 。',
    ],
    [
      'See www.a.example/%E3%80%82 and https://b.example/docs.',
      '详见 www.a.example/%E3%80%82，\n另见 https://b.example/docs。',
      '详见 www.a.example/%E3%80%82 ，\n另见 https://b.example/docs 。',
    ],
    [
      'See [https://a.example/docs。](https://a.example/docs。).',
      '详见 [https://a.example/docs。](https://a.example/docs。)。',
    ],
  ])(
    'accepts a bare URL next to other punctuation in %s',
    async (original, translated, displayed = translated) => {
      const target = /\p{Script=Han}/u.test(translated) ? 'zh-CN' : 'en';
      await expect(
        translateDisplayText(original, target, answer(translated), signal),
      ).resolves.toBe(displayed);
    },
  );

  it('keeps terminal bare-link text as emitted by the model', async () => {
    const translated = '详见 https://a.example/docs。';
    await expect(
      translateDisplayText(
        'See https://a.example/docs.',
        'zh-CN',
        answer(translated),
        signal,
        'terminal',
      ),
    ).resolves.toBe(translated);
  });

  it.each([
    [
      'See [the release notes][release].\n\n[release]: https://example.test/releases',
      '详见[发行说明][版本]。\n\n[release]: https://example.test/releases',
    ],
    [
      'See [the diagram][diagram].\n\n[diagram]: https://example.test/diagram.svg',
      '详见![示意图][diagram]。\n\n[diagram]: https://example.test/diagram.svg',
    ],
    [
      'See [the diagram](https://example.test/diagram.svg).',
      '详见![示意图](https://example.test/diagram.svg)。',
    ],
    [
      'See [the release notes][release].\n\n[release]: https://example.test/releases\n[docs]: https://example.test/docs',
      '详见[发行说明][release]。\n\n[release]: https://example.test/docs\n[docs]: https://example.test/releases',
    ],
    [
      'See [the release notes][release] and [the guide][docs].\n\n[release]: https://example.test/releases\n[docs]: https://example.test/docs',
      '详见[发行说明][release]和[指南][docs]。\n\n[release]: https://example.test/docs\n[docs]: https://example.test/releases',
    ],
    [
      'See [the release notes][release].\n\n[release]: https://example.test/releases\n[release]: https://example.test/docs',
      '详见[发行说明][release]。\n\n[release]: https://example.test/docs\n[release]: https://example.test/releases',
    ],
  ])(
    'rejects changes to rendered link or image targets in %s',
    async (original, translated) => {
      const complete = answer(translated);
      await expect(
        translateDisplayText(original, 'zh-CN', complete, signal),
      ).resolves.toBeUndefined();
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it('accepts translated labels for references with the same destinations', async () => {
    const original =
      'See [release notes][Release] and ![the diagram][diagram].\n\n[release]: https://example.test/releases\n[diagram]: https://example.test/diagram.svg';
    const translated =
      '详见[发行说明][release]和![示意图][Diagram]。\n\n[DIAGRAM]: https://example.test/diagram.svg\n[RELEASE]: https://example.test/releases';
    await expect(
      translateDisplayText(original, 'zh-CN', answer(translated), signal),
    ).resolves.toBe(translated);
  });

  it.each([
    [
      'See <https://example.test/releases_>.',
      '详见 https://example.test/releases_。',
    ],
    [
      '| Release |\n| --- |\n| <https://example.test/releases_> |',
      '| 发布 |\n| --- |\n| https://example.test/releases_。 |',
    ],
    [
      '| A | B | C |\n| --- | --- | --- |\n| **First | <https://example.test/releases_> | Third** |',
      '| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| **第一 | https://example.test/releases_。 | 第三** |',
    ],
    [
      '* See <https://example.test/releases_> for the *release notes*.',
      '* 详见 https://example.test/releases_。 请阅读 *发行说明*。',
    ],
    [
      '| A | B | C |\n| --- | --- | --- |\n$$\nx+y\n$$\n| **First | <https://example.test/releases_> | Third** |',
      '| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n$$\nx+y\n$$\n| **第一 | https://example.test/releases_。 | 第三** |',
    ],
  ])(
    'rejects a translation whose clickable terminal URL changes: %s',
    async (original, translated) => {
      const complete = answer(translated);
      await expect(
        translateDisplayText(original, 'zh-CN', complete, signal, 'terminal'),
      ).resolves.toBeUndefined();
      expect(complete).toHaveBeenCalledOnce();
    },
  );

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
    ['See [docs](https://a.example).', '参见[文档](https://evil.example)。'],
    ['See the docs.', '参见文档。![](https://evil.example/p)'],
    [
      'See https://github.com for the docs.',
      '文档见 https://github.com．ｅｖｉｌ．ｃｏｍ',
    ],
    ['See https://github.com for the docs.', '文档见 https://github.com。公司'],
    ['See https://github.com for the docs.', '文档见 https://github.com．公司'],
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

  it.each([
    ['The cost is $O(n^2)$.', '代价是 $O(n)$。'],
    ['Line one<br>line two.', '第一行<br onclick="x">第二行。'],
  ])(
    'keeps the original when the translation changes math or HTML in %s',
    async (original, translated) => {
      await expect(
        translateDisplayText(original, 'zh-CN', answer(translated), signal),
      ).resolves.toBeUndefined();
    },
  );

  it('keeps terminal code that is fenced inside a Markdown paragraph', async () => {
    const original = 'Run this command:\n    ~~~sh\n    npm test\n    ~~~';
    const translated = '运行以下命令：\n    ~~~sh\n    npm test\n    ~~~';
    const changed = answer(translated.replace('npm test', 'npm run build'));
    await expect(
      translateDisplayText(original, 'zh-CN', changed, signal, 'terminal'),
    ).resolves.toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
    await expect(
      translateDisplayText(
        original,
        'zh-CN',
        answer(translated),
        signal,
        'terminal',
      ),
    ).resolves.toBe(translated);
  });

  it.each([
    ['See the docs.', '参见\\[文档](https://attacker.example)。'],
    ['See the docs.', '<div>\n[文档](https://attacker.example)\n</div>'],
  ])(
    'keeps the original when a terminal link target changes: %s -> %j',
    async (original, translated) => {
      await expect(
        translateDisplayText(
          original,
          'zh-CN',
          answer(translated),
          signal,
          'terminal',
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    [
      'Install from https://a.example/releases.',
      '从 https://evil.example/releases 安装。',
    ],
    ['Install it.', '安装它：https://evil.example/releases。'],
    ['Install from https://a.example/releases.', '安装它。'],
    ['See https://a.example.', '参见 https://a.example。evil.example/x'],
    ['See https://a.example/docs.', '参见 https://a.example/admin。'],
    ['See https://a.example/?q=1.', '参见 https://a.example/?q=2。'],
    [
      'See [https://a.example/docs](https://a.example/docs).',
      '详见 [https://a.example/docs。](https://a.example/docs。)。',
    ],
    ['Open <foo:bar>.', '打开 <foo:bar。>'],
    ['Mail <mailto:a@b.example>.', '发邮件到 <mailto:a@b.example。>。'],
    ['See https://a.example/docs.', '详见 https://a.example/docs”'],
    ['Mail <mailto:a@b.example>.', '发邮件到 <mailto:a@b.example．ｃｎ>。'],
    ['Mail <mailto:a@b.example>.', '发邮件到 <mailto:a@evil.example>。'],
    ['Mail a@b.example.', '发邮件到 a@evil.example。'],
    ['See https://a.example/文档.', '参见 https://a.example/资料。'],
    [
      'Visit https://a.example/docs, then run it.',
      '请访问 https://a.example/docs，然后运行。',
    ],
  ])(
    'keeps the original when a bare URL changes: %s -> %j',
    async (original, translated) => {
      await expect(
        translateDisplayText(original, 'zh-CN', answer(translated), signal),
      ).resolves.toBeUndefined();
    },
  );

  it('falls back if separating punctuation would also remove a URL character', async () => {
    await expect(
      translateDisplayText(
        'See <https://a.example/docs!>.',
        'zh-CN',
        answer('详见 https://a.example/docs!。'),
        signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps the original when a translation adds a non-web bare link', async () => {
    await expect(
      translateDisplayText(
        'See the session.',
        'zh-CN',
        answer('参见 <qwen-session://abc>。'),
        signal,
      ),
    ).resolves.toBeUndefined();
  });

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
