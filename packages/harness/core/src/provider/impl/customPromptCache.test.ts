/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ModelPrompt } from '../modelStreamRequest.js';
import { applyPromptCachePolicy } from './customPromptCache.js';

const tip = { type: 'ephemeral' } as const;

function prompt(): ModelPrompt {
  return {
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'stable' },
          { type: 'text', text: 'dynamic' },
          { type: 'text', text: '' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'q', cacheControl: tip }] },
    ],
  };
}

describe('applyPromptCachePolicy', () => {
  it.each(['result', [{ type: 'text', text: 'result' }]] as const)(
    '工具结果外层断点支持 TTL 改写及关闭，正文保持原状：%j',
    (content) => {
      const input: ModelPrompt = {
        messages: [
          {
            role: 'tool',
            toolCallId: 'read',
            content,
            cacheControl: tip,
          },
        ],
      };
      const saved = structuredClone(input);
      const policy = { type: 'ephemeral', ttl: '1h' } as const;
      expect(applyPromptCachePolicy(input, policy).messages[0]).toEqual({
        ...input.messages[0],
        cacheControl: policy,
      });
      const disabled = applyPromptCachePolicy(input, undefined);
      expect(disabled.messages[0]).toEqual({
        role: 'tool',
        toolCallId: 'read',
        content,
      });
      expect(applyPromptCachePolicy(disabled, undefined)).toBe(disabled);
      expect(input).toEqual(saved);
    },
  );

  it('开启时在 system 末个非空块补断点，并统一已有断点的 TTL', () => {
    const cacheControl = { type: 'ephemeral', ttl: '1h' } as const;
    expect(applyPromptCachePolicy(prompt(), cacheControl).messages).toEqual([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'stable' },
          { type: 'text', text: 'dynamic', cacheControl },
          { type: 'text', text: '' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'q', cacheControl }] },
    ]);
  });

  it('字符串 system 转为带断点的单个文本块，只标记连续前置 system 的最后一条', () => {
    const result = applyPromptCachePolicy(
      {
        messages: [
          { role: 'system', content: 'first' },
          { role: 'system', content: 'second' },
          { role: 'user', content: 'q' },
          { role: 'system', content: 'later' },
        ],
      },
      tip,
    );
    expect(result.messages).toEqual([
      { role: 'system', content: 'first' },
      {
        role: 'system',
        content: [{ type: 'text', text: 'second', cacheControl: tip }],
      },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'later' },
    ]);
  });

  it('关闭时清除上游断点，不改写 system', () => {
    const input = prompt();
    const result = applyPromptCachePolicy(input, undefined);
    expect(result.messages[0]).toBe(input.messages[0]);
    expect(result.messages[1]).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'q' }],
    });
  });

  it('无需改写时返回原 prompt', () => {
    const input: ModelPrompt = { messages: [{ role: 'user', content: 'q' }] };
    expect(applyPromptCachePolicy(input, undefined)).toBe(input);
  });

  it('工具结果原有内部断点与整体断点一起改写或清除', () => {
    const input: ModelPrompt = {
      messages: [
        {
          role: 'tool',
          toolCallId: 'read',
          cacheControl: tip,
          content: [{ type: 'text', text: 'result', cacheControl: tip }],
        },
      ],
    };
    const cacheControl = { type: 'ephemeral', ttl: '1h' } as const;
    expect(applyPromptCachePolicy(input, cacheControl).messages[0]).toEqual({
      role: 'tool',
      toolCallId: 'read',
      cacheControl,
      content: [{ type: 'text', text: 'result', cacheControl }],
    });
    expect(applyPromptCachePolicy(input, undefined).messages[0]).toEqual({
      role: 'tool',
      toolCallId: 'read',
      content: [{ type: 'text', text: 'result' }],
    });
  });
});
