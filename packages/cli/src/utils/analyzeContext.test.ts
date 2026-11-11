/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@qwen-code/core';
import type { ModelStreamMessage } from '@qwen-code/core';
import { analyzeContext, estimateString, roughEstimate } from './analyzeContext.js';

afterEach(() => vi.restoreAllMocks());

function analyzeModelMessages(messages: readonly ModelStreamMessage[]) {
  vi.spyOn(core, 'normalizeMessagesForAPI').mockReturnValue([...messages]);
  return analyzeContext([]);
}

describe('context token estimation', () => {
  it('weights non-ASCII text separately from ASCII text', () => {
    expect(estimateString('abcd中文')).toBe(4);
  });

  it('applies non-ASCII weighting to serialized context values', () => {
    expect(roughEstimate({ text: '中文' })).toBe(5);
  });

  it('scans non-ASCII text beyond 100,000 characters', () => {
    expect(estimateString(`${'a'.repeat(100_000)}中文`)).toBe(25_003);
  });

  it('从标准 toolCalls 与独立工具结果统计重复 Read，不重复累加分类', () => {
    const messages: ModelStreamMessage[] = [];
    for (let index = 0; index < 2; index++) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: `read-${index}`,
            name: core.READ_FILE_TOOL_NAME,
            arguments: JSON.stringify({ file_path: '/workspace/a.ts' }),
          }],
        },
        { role: 'tool', toolCallId: `read-${index}`, content: 'abcd' },
      );
    }
    const stats = analyzeModelMessages(messages);
    expect(stats.toolResults.get(core.READ_FILE_TOOL_NAME)).toBe(2);
    expect(stats.duplicateFileReads.get('/workspace/a.ts')).toEqual({
      count: 2,
      tokens: 1,
    });
    expect(stats.total).toBe(stats.humanMessages + stats.assistantMessages);
    expect(Number.isFinite(stats.total)).toBe(true);
  });

  it('Skill 结果归属直接读取 arguments，图片工具结果按标准内容计数', () => {
    const stats = analyzeModelMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'skill-1',
          name: core.SKILL_TOOL_NAME,
          arguments: JSON.stringify({ skill: 'test-skill' }),
        }],
      },
      {
        role: 'tool',
        toolCallId: 'skill-1',
        content: [
          { type: 'text', text: 'abcd' },
          { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
        ],
      },
    ]);
    const tokens = 1 + core.estimateRequestBlockTokens({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/a.png' },
    });
    expect(stats.skillTokens.get('test-skill')).toBe(tokens);
    expect(stats.toolResults.get(core.SKILL_TOOL_NAME)).toBe(tokens);
  });

  it('损坏的工具参数仍计数但不虚构文件归属，孤立结果归 unknown', () => {
    const stats = analyzeModelMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'broken', name: core.READ_FILE_TOOL_NAME, arguments: '{' }],
      },
      { role: 'tool', toolCallId: 'broken', content: 'abcd' },
      { role: 'tool', toolCallId: 'orphan', content: 'abcd' },
    ]);
    expect(stats.toolRequests.get(core.READ_FILE_TOOL_NAME)).toBeGreaterThan(0);
    expect(stats.toolResults.get('unknown')).toBe(1);
    expect(stats.duplicateFileReads.size).toBe(0);
    expect(Number.isFinite(stats.total)).toBe(true);
  });

  it('标准思考块与用户图片分类不依赖旧 reasoning 或图片字段', () => {
    const image: core.ModelImageBlock = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'aW1hZ2U=' },
    };
    const stats = analyzeModelMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'abcd', reasoning: { id: 'reason-1' } },
          { type: 'redacted_thinking', data: 'abcd' },
          { type: 'text', text: 'abcd' },
        ],
      },
      { role: 'user', content: [image, { type: 'text', text: 'abcd' }] },
    ]);
    expect(stats.thinkingTokens).toBe(2);
    expect(stats.humanMessages).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.other).toBe(core.estimateRequestBlockTokens(image));
    expect(stats.total).toBe(4 + stats.other);
  });
});
