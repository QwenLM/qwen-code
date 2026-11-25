/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { INTERRUPT_MESSAGE } from '../protocol/transcript/message-utils.js';
import {
  extractSessionTitleText,
  getSessionTitleUserText,
} from './sessionTitleText.js';

describe('标题正文提取', () => {
  it.each(['command-name', 'bash-input', 'local-command-stdout'])(
    '未知包装中的 %s 不能排除包装外的用户需求',
    (tag) => {
      const input = `<context><${tag}>/help</${tag}></context>\n修复登录`;
      expect(getSessionTitleUserText(createUserMessage(input))).toBe(
        '修复登录',
      );
    },
  );

  it('同行闭合三反引号按行内代码保留，后续内部块仍移除', () => {
    const input =
      '```<b>示例</b>```\n<system-reminder>内部提示</system-reminder>\n修复登录';
    const expected = '```<b>示例</b>```\n \n修复登录';
    expect(extractSessionTitleText(input)).toBe(expected);
    expect(getSessionTitleUserText(createUserMessage(input))).toBe(expected);
  });

  it.each(['system-reminder', 'context'])(
    '四空格代码块内的 %s 示例保持完整',
    (tag) => {
      const input = `分析这段代码\n\n    <${tag}>示例</${tag}>`;
      expect(extractSessionTitleText(input)).toBe(input);
      expect(getSessionTitleUserText(createUserMessage(input))).toBe(input);
    },
  );

  it('消息首行缩进不能在进入提取器前被抹掉', () => {
    const input = '    <context>示例</context>\n\n分析代码';
    expect(getSessionTitleUserText(createUserMessage(input))).toBe(
      input.trim(),
    );
    expect(
      getSessionTitleUserText(
        createUserMessage([{ type: 'text', text: input }]),
      ),
    ).toBe(input.trim());
  });

  it('连续缩进代码保留，恢复普通正文后内部块仍应移除', () => {
    const code = '    <context>\n    示例\n    </context>';
    const input = `分析代码\n\n${code}\n\n<system-reminder>内部提示</system-reminder>\n修复登录`;
    const result = getSessionTitleUserText(createUserMessage(input));
    expect(result).toContain(code);
    expect(result).toContain('修复登录');
    expect(result).not.toContain('内部提示');
  });

  it('转义反引号不能跨入内部块建立代码区域', () => {
    const input =
      '解释 \\` 字符\n<system-reminder>内部 ` 提示</system-reminder>\n修复登录';
    const expected = '解释 \\` 字符\n \n修复登录';
    expect(extractSessionTitleText(input)).toBe(expected);
    expect(getSessionTitleUserText(createUserMessage(input))).toBe(expected);
  });

  it('偶数个反斜杠不转义反引号，合法代码仍受保护', () => {
    const input = '\\\\`<system-reminder>示例</system-reminder>`';
    expect(extractSessionTitleText(input)).toBe(input);
  });

  it.each(['</context />', '</system-reminder />'])(
    '异常结束标签 %s 原样保留',
    (tag) => {
      const input = `${tag}\n修复登录`;
      expect(extractSessionTitleText(input)).toBe(input);
      expect(getSessionTitleUserText(createUserMessage(input))).toBe(input);
    },
  );

  it.each([
    ['普通正文', '  修复登录\n保留换行  ', '修复登录\n保留换行'],
    [
      '委派前缀',
      '<qoder_delegated_input_sources>来源</qoder_delegated_input_sources>\n\n修复登录',
      '修复登录',
    ],
    ['多行前缀', '<context>\n来源\n</context>\n修复登录', '修复登录'],
    ['后缀', '修复登录\n<context>附件</context>', '修复登录'],
    ['首尾包装', '<a>来源</a>\n修复登录\n<b>附件</b>', '修复登录'],
    ['连续前缀', '<a>来源</a>\n<b>附件</b>\n修复登录', '修复登录'],
    ['连续后缀', '修复登录\n<a>来源</a>\n<b>附件</b>', '修复登录'],
    ['仅未知包装', '<request>修复登录</request>', '修复登录'],
    ['嵌套降级', '<a><b>修复登录</b></a>', '修复登录'],
    ['同名嵌套', '<a><a>来源</a></a>\n修复登录', '修复登录'],
    [
      '属性包含尖括号',
      '<context source="a > b" other=\'c < d\'>来源</context>\n修复登录',
      '修复登录',
    ],
    [
      '带属性嵌套降级',
      '<request id="x"><part>修复登录</part></request>',
      '修复登录',
    ],
    [
      'JSON 不作业务解析',
      '<request>{"request":"修复登录"}</request>',
      '{"request":"修复登录"}',
    ],
    ['空包装', '<context></context>', ''],
    ['自闭合前缀', '<context />\n修复登录', '修复登录'],
    ['自闭合无正文', '<context />', ''],
    ['行内 HTML', '为什么 <b>加粗</b> 不生效', '为什么 <b>加粗</b> 不生效'],
    [
      '行内组件',
      '<Button>提交</Button> 为什么不响应',
      '<Button>提交</Button> 为什么不响应',
    ],
    [
      '同行混排',
      '<context>来源</context> 修复登录',
      '<context>来源</context> 修复登录',
    ],
    [
      '正文中间块',
      '第一段\n<div>示例</div>\n第二段',
      '第一段\n<div>示例</div>\n第二段',
    ],
    ['比较符与泛型', '解释 a < b 与 Array<T>', '解释 a < b 与 Array<T>'],
    ['未知块未闭合', '<context>来源\n修复登录', '<context>来源\n修复登录'],
    [
      '未知块交错',
      '<a><b>来源</a></b>\n修复登录',
      '<a><b>来源</a></b>\n修复登录',
    ],
    [
      '行内代码',
      '解释 `<context>来源</context>`',
      '解释 `<context>来源</context>`',
    ],
    [
      '围栏代码',
      '```xml\n<context>来源</context>\n```',
      '```xml\n<context>来源</context>\n```',
    ],
    [
      '波浪线围栏',
      '~~~xml\n<context>来源</context>\n~~~',
      '~~~xml\n<context>来源</context>\n~~~',
    ],
    [
      '代码里的内部标签',
      '```xml\n<system-reminder>示例</system-reminder>\n```',
      '```xml\n<system-reminder>示例</system-reminder>\n```',
    ],
    [
      '行内代码里的内部标签',
      '`<system-reminder>示例</system-reminder>`',
      '`<system-reminder>示例</system-reminder>`',
    ],
    [
      '内部未闭合围栏',
      '<loaded_context>\n```ts\n内部提示\n</loaded_context>\n修复登录',
      '修复登录',
    ],
    [
      '内部未闭合反引号不干扰后续',
      '<system-reminder>`内部提示</system-reminder>\n<context>来源</context>\n修复登录',
      '修复登录',
    ],
    [
      '内部块与后续代码隔离',
      '<loaded_context>\n```ts\n提示\n</loaded_context>\n```xml\n<div>示例</div>\n```',
      '```xml\n<div>示例</div>\n```',
    ],
  ])('%s', (_name, input, expected) => {
    expect(extractSessionTitleText(input)).toBe(expected);
  });

  it.each([
    'system-reminder',
    'hook_context',
    'local-command-caveat',
    'loaded_context',
  ])('%s 不能降级进入标题或成为来源候选', (tag) => {
    const internal = `<${tag}>内部提示</${tag}>`;
    expect(extractSessionTitleText(internal)).toBe('');
    expect(getSessionTitleUserText(createUserMessage(internal))).toBeNull();
    expect(
      extractSessionTitleText(`<request>${internal}修复登录</request>`),
    ).toBe('修复登录');
    expect(
      extractSessionTitleText(`修复登录\n${internal}\n继续排查`).split(/\s+/),
    ).toEqual(['修复登录', '继续排查']);
  });

  it('多个未知包装的降级内容按顺序分隔', () => {
    expect(
      extractSessionTitleText('<a>分析</a>\n<b>登录故障</b>').split(/\s+/),
    ).toEqual(['分析', '登录故障']);
  });

  it('跨 text block 优先取真实正文，不拼接来源降级内容', () => {
    const message = createUserMessage([
      { type: 'text', text: '<context>来源</context>' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'test' },
      },
      { type: 'text', text: '修复登录' },
    ]);
    expect(getSessionTitleUserText(message)).toBe('修复登录');
  });

  it.each([
    { isMeta: true },
    { isCompactSummary: true },
    { isVisibleInTranscriptOnly: true },
    { origin: { kind: 'system' as const } },
  ])('内部消息标志不因包装降级被放行：%j', (options) => {
    expect(
      getSessionTitleUserText(
        createUserMessage('<request>修复登录</request>', options),
      ),
    ).toBeNull();
  });

  it.each([undefined, { kind: 'human' as const }])(
    '缺省或 human origin 可提取：%j',
    (origin) => {
      expect(
        getSessionTitleUserText(createUserMessage('修复登录', { origin })),
      ).toBe('修复登录');
    },
  );

  it.each([
    '/resume',
    '?help',
    INTERRUPT_MESSAGE,
    '<command-name>/help</command-name>',
    '<bash-input>pwd</bash-input>',
    '<local-command-stdout>输出</local-command-stdout>',
    '<bash-stdout>输出</bash-stdout><bash-stderr></bash-stderr>',
    '<loaded_context>上下文</loaded_context>\n/rename',
  ])('命令与合成消息不作为用户需求：%s', (text) => {
    expect(getSessionTitleUserText(createUserMessage(text))).toBeNull();
  });

  it('工具结果不作为标题正文', () => {
    expect(
      getSessionTitleUserText(
        createUserMessage([
          { type: 'tool_result', tool_use_id: 'tool', content: '修复登录' },
        ]),
      ),
    ).toBeNull();
  });
});
