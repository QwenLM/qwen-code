/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildFeishuWebhookCard } from './webhook-card.js';

describe('Feishu webhook static card', () => {
  it('preserves Markdown and Unicode without adding summaries or controls', () => {
    const text =
      '# 完成 😀\n\n**Report**\n- [Details](https://example.com)\n> Done';
    expect(buildFeishuWebhookCard(text)).toEqual({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: text }] },
    });
  });

  it.each([
    ['<at id=all></at>', '&#60;at id=all&#62;&#60;/at&#62;'],
    ['<at id="ou_user"></at>', '&#60;at id="ou_user"&#62;&#60;/at&#62;'],
    ["<at ids='a,b'></at>", "&#60;at ids='a,b'&#62;&#60;/at&#62;"],
    ['<AT\n id = all ></AT >', '&#60;AT\n id = all &#62;&#60;/AT &#62;'],
    ['<at id="a>b"></at>', '&#60;at id="a&#62;b"&#62;&#60;/at&#62;'],
    [
      '<font color="red"><at id=all></at></font>',
      '<font color="red">&#60;at id=all&#62;&#60;/at&#62;</font>',
    ],
    [
      '```xml\n<at id=all></at>\n```',
      '```xml\n&#60;at id=all&#62;&#60;/at&#62;\n```',
    ],
    ['`<at id=all></at>`', '`&#60;at id=all&#62;&#60;/at&#62;`'],
    ['&#60;at id=all&#62; &lt;at&gt;', '&#60;at id=all&#62; &lt;at&gt;'],
    ['<attribute> <atlas> x < y', '<attribute> <atlas> x < y'],
    ['<at id=all', '<at id=all'],
  ])('makes complete mention markup literal: %s', (text, expected) => {
    expect(buildFeishuWebhookCard(text).body.elements).toEqual([
      { tag: 'markdown', content: expected },
    ]);
  });

  it('keeps several tables in separate elements of one card', () => {
    const tables = Array.from(
      { length: 5 },
      (_, index) => `| Item | Value |\n| --- | --- |\n| ${index} | 完成 😀 |`,
    );
    const card = buildFeishuWebhookCard(tables.join('\n\n'));
    expect(card.body.elements.map(({ content }) => content.trim())).toEqual(
      tables,
    );
    expect(card.body.elements.every(({ tag }) => tag === 'markdown')).toBe(
      true,
    );
  });

  it.each(
    ['', '- [ ] ', '- [X] '].flatMap((prefix) =>
      ['```', '~~~'].map((fence) => ({ prefix, fence })),
    ),
  )(
    'preserves $prefix / $fence code regions beside real tables',
    ({ prefix, fence }) => {
      const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      const indent = ' '.repeat(prefix.length);
      const code = `${prefix}${fence}text\n${indent}${table.replaceAll('\n', `\n${indent}`)}\n${indent}${fence}`;
      const card = buildFeishuWebhookCard(`${table}\n${code}\n${table}`);
      expect(card.body.elements.map(({ content }) => content)).toEqual([
        table,
        code,
        table,
      ]);
    },
  );
});
