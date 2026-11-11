/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ToolUseResultBuilder,
  partListUnionToContent,
} from './tool-use-result-builder.js';
import type { ToolUseContext } from './tool-types.js';
import type { ToolResultContent } from './tool-result-message.js';
import type { PartListUnion } from '@google/genai';
import { READ_FILE_TOOL_NAME } from './tool-names.js';

// ---------------------------------------------------------------------------
// partListUnionToContent
// ---------------------------------------------------------------------------

describe('partListUnionToContent', () => {
  it('returns string unchanged when input is a string', () => {
    expect(partListUnionToContent('hello')).toBe('hello');
  });

  it('returns empty string unchanged', () => {
    expect(partListUnionToContent('')).toBe('');
  });

  it('将宿主文本结果转换为工具域内容块', () => {
    const result = partListUnionToContent([
      { text: 'line 1' },
      { text: 'line 2' },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ]);
  });

  it('converts Part[] with inlineData to image parts', () => {
    const result = partListUnionToContent([
      { inlineData: { data: 'base64data', mimeType: 'image/jpeg' } },
    ]);
    expect(result).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/jpeg',
          data: 'base64data',
        },
      },
    ]);
  });

  it('defaults inlineData mimeType to image/png', () => {
    const result = partListUnionToContent([{ inlineData: { data: 'abc' } }]);
    if (typeof result === 'string') throw new Error('应输出工具域图片块');
    expect(result[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png' },
    });
  });

  it('replaces unsupported inline SVG data with a text placeholder', () => {
    const result = partListUnionToContent([
      { inlineData: { data: 'PHN2Zz4=', mimeType: 'image/svg+xml' } },
    ]);
    expect(result).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
      },
    ]);
  });

  it('converts image fileData to URL image parts', () => {
    const result = partListUnionToContent([
      {
        fileData: {
          fileUri: 'https://assets.example.test/read-image.png',
          mimeType: 'image/png',
        },
      },
    ]);
    expect(result).toEqual([
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://assets.example.test/read-image.png',
        },
      },
    ]);
  });

  it('replaces unsupported SVG fileData with a text placeholder', () => {
    const result = partListUnionToContent([
      {
        fileData: {
          fileUri: 'https://assets.example.test/diagram.svg',
          mimeType: 'image/svg+xml',
        },
      },
    ]);
    expect(result).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
      },
    ]);
  });

  it('converts string items in Part[] to text parts', () => {
    // @google/genai PartListUnion allows string[] too
    const result = partListUnionToContent([
      'hello',
      'world',
    ] as unknown as PartListUnion);
    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('returns "(no content)" for empty Part[]', () => {
    expect(partListUnionToContent([])).toBe('(no content)');
  });

  it('skips inlineData parts with no data', () => {
    const result = partListUnionToContent([
      { inlineData: { data: '', mimeType: 'image/png' } },
      { text: 'valid' },
    ]);
    expect(result).toEqual([{ type: 'text', text: 'valid' }]);
  });

  it('handles a single Part object with text', () => {
    const result = partListUnionToContent({
      text: 'solo',
    } as unknown as PartListUnion);
    expect(result).toBe('solo');
  });

  it('JSON-stringifies a single Part object without text', () => {
    const result = partListUnionToContent({
      functionCall: { name: 'x' },
    } as unknown as PartListUnion);
    expect(result).toBe(JSON.stringify({ functionCall: { name: 'x' } }));
  });
});

// ---------------------------------------------------------------------------
// ToolUseResultBuilder
// ---------------------------------------------------------------------------

describe('ToolUseResultBuilder', () => {
  describe('build() with only addToolResult', () => {
    it('produces a single tool_result message', () => {
      const builder = new ToolUseResultBuilder('call-1', READ_FILE_TOOL_NAME);
      builder.addToolResult('file contents', false);

      const messages = builder.build();
      expect(messages).toHaveLength(1);
      expect(messages[0].message.type).toBe('tool_result');
      if (messages[0].message.type === 'tool_result') {
        expect(messages[0].message.toolCallId).toBe('call-1');
        expect(messages[0].message.content).toBe('file contents');
        expect(messages[0].message.isError).toBe(false);
      }
    });

    it('marks error tool_results correctly', () => {
      const builder = new ToolUseResultBuilder('call-2', 'bash');
      builder.addToolResult('Permission denied', true);

      const messages = builder.build();
      expect(messages[0].message.type).toBe('tool_result');
      if (messages[0].message.type === 'tool_result') {
        expect(messages[0].message.isError).toBe(true);
      }
    });

    it('保留工具域结果内容', () => {
      const content: ToolResultContent = [
        { type: 'text', text: 'prefix' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
        },
      ];
      const builder = new ToolUseResultBuilder('call-3', 'screenshot');
      builder.addToolResult(content, false);

      const messages = builder.build();
      if (messages[0].message.type === 'tool_result') {
        expect(messages[0].message.content).toEqual(content);
        expect(messages[0].message.content).toBe(content);
      }
    });

    it('收集只读工具域内容并保留缓存、错误标记和调用归属', () => {
      const content = Object.freeze([
        Object.freeze({
          type: 'text' as const,
          text: 'details',
          cacheControl: Object.freeze({
            type: 'ephemeral' as const,
            ttl: '5m',
          }),
        }),
        Object.freeze({
          type: 'image' as const,
          source: Object.freeze({
            type: 'url' as const,
            url: 'https://assets.example.test/tool.png',
          }),
        }),
      ]) satisfies ToolResultContent;
      const builder = new ToolUseResultBuilder('frozen-call', 'screenshot');
      builder.addToolResult(content, true);
      expect(builder.build()[0].message).toEqual({
        type: 'tool_result',
        toolCallId: 'frozen-call',
        content,
        isError: true,
      });
    });
  });

  describe('addNewMessages', () => {
    it('appends supplementary messages after tool_result', () => {
      const builder = new ToolUseResultBuilder('call-4', READ_FILE_TOOL_NAME);
      builder.addToolResult('ok', false);
      builder.addNewMessages([
        { role: 'user', content: 'supplementary text' },
        { role: 'user', content: [{ text: 'multi-modal' }] },
      ]);

      const messages = builder.build();
      expect(messages).toHaveLength(3);
      expect(messages[0].message.type).toBe('tool_result');
      expect(messages[1].message.type).toBe('supplementary');
      expect(messages[2].message.type).toBe('supplementary');

      if (messages[1].message.type === 'supplementary') {
        expect(messages[1].message.content).toBe('supplementary text');
      }
    });

    it('handles undefined newMessages gracefully', () => {
      const builder = new ToolUseResultBuilder('call-5', 'test');
      builder.addToolResult('ok', false);
      builder.addNewMessages(undefined);

      const messages = builder.build();
      expect(messages).toHaveLength(1);
    });

    it('handles empty newMessages array gracefully', () => {
      const builder = new ToolUseResultBuilder('call-6', 'test');
      builder.addToolResult('ok', false);
      builder.addNewMessages([]);

      const messages = builder.build();
      expect(messages).toHaveLength(1);
    });
  });

  describe('addPreHookContext', () => {
    it('inserts hook_context before tool_result when called first', () => {
      const builder = new ToolUseResultBuilder('call-7', 'bash');
      builder.addPreHookContext({ additionalContext: 'CWD is /home' });
      builder.addToolResult('ok', false);

      const messages = builder.build();
      expect(messages).toHaveLength(2);
      expect(messages[0].message.type).toBe('hook_context');
      if (messages[0].message.type === 'hook_context') {
        expect(messages[0].message.source).toBe('PreToolUse:bash');
        expect(messages[0].message.text).toBe('CWD is /home');
      }
      expect(messages[1].message.type).toBe('tool_result');
    });

    it('skips when hookResult is undefined', () => {
      const builder = new ToolUseResultBuilder('call-8', 'bash');
      builder.addPreHookContext(undefined);
      builder.addToolResult('ok', false);

      expect(builder.build()).toHaveLength(1);
    });

    it('skips when additionalContext is undefined', () => {
      const builder = new ToolUseResultBuilder('call-9', 'bash');
      builder.addPreHookContext({ hookPermissionResult: 'allow' });
      builder.addToolResult('ok', false);

      expect(builder.build()).toHaveLength(1);
    });
  });

  describe('addPostHookContext', () => {
    it('inserts hook_context messages after tool_result', () => {
      const builder = new ToolUseResultBuilder('call-10', 'write');
      builder.addToolResult('ok', false);
      builder.addPostHookContext({
        additionalContexts: ['File was backed up', 'Lint passed'],
      });

      const messages = builder.build();
      expect(messages).toHaveLength(3);
      expect(messages[1].message.type).toBe('hook_context');
      expect(messages[2].message.type).toBe('hook_context');
      if (messages[1].message.type === 'hook_context') {
        expect(messages[1].message.source).toBe('PostToolUse:write');
        expect(messages[1].message.text).toBe('File was backed up');
      }
    });

    it('skips when hookResult is undefined', () => {
      const builder = new ToolUseResultBuilder('call-11', 'test');
      builder.addToolResult('ok', false);
      builder.addPostHookContext(undefined);

      expect(builder.build()).toHaveLength(1);
    });
  });

  describe('addStop', () => {
    it('appends a stop message last', () => {
      const builder = new ToolUseResultBuilder('call-12', 'bash');
      builder.addToolResult('ok', false);
      builder.addStop('hook requested stop');

      const messages = builder.build();
      expect(messages).toHaveLength(2);
      expect(messages[1].message.type).toBe('stop');
      if (messages[1].message.type === 'stop') {
        expect(messages[1].message.reason).toBe('hook requested stop');
      }
    });
  });

  describe('full pipeline ordering', () => {
    it('maintains [preHook, tool_result, postHook, supplementary, stop] order', () => {
      const builder = new ToolUseResultBuilder('call-13', READ_FILE_TOOL_NAME);
      builder.addPreHookContext({ additionalContext: 'pre ctx' });
      builder.addToolResult('file data', false);
      builder.addPostHookContext({ additionalContexts: ['post ctx'] });
      builder.addNewMessages([{ role: 'user', content: 'image data' }]);
      builder.addStop('user requested');

      const messages = builder.build();
      const types = messages.map((m) => m.message.type);
      expect(types).toEqual([
        'hook_context', // pre
        'tool_result', // main
        'hook_context', // post
        'supplementary', // newMessages
        'stop', // stop
      ]);
    });
  });

  describe('contextModifier', () => {
    it('stores contextModifier and exposes via getContextModifier()', () => {
      const modifier = (ctx: ToolUseContext): ToolUseContext => ({
        ...ctx,
        callId: 'modified',
      });

      const builder = new ToolUseResultBuilder('call-14', 'bash');
      builder.addToolResult('ok', false, modifier);

      expect(builder.getContextModifier()).toBe(modifier);
    });

    it('attaches contextModifier to the tool_result message', () => {
      const modifier = (ctx: ToolUseContext): ToolUseContext => ctx;

      const builder = new ToolUseResultBuilder('call-15', 'bash');
      builder.addToolResult('ok', false, modifier);

      const messages = builder.build();
      expect(messages[0].contextModifier).toBeDefined();
      expect(messages[0].contextModifier!.toolCallId).toBe('call-15');
      expect(messages[0].contextModifier!.modifyContext).toBe(modifier);
    });

    it('returns undefined when no contextModifier provided', () => {
      const builder = new ToolUseResultBuilder('call-16', 'bash');
      builder.addToolResult('ok', false);

      expect(builder.getContextModifier()).toBeUndefined();
      expect(builder.build()[0].contextModifier).toBeUndefined();
    });
  });

  describe('build() immutability', () => {
    it('returns a defensive copy', () => {
      const builder = new ToolUseResultBuilder('call-17', 'test');
      builder.addToolResult('ok', false);

      const first = builder.build();
      const second = builder.build();

      expect(first).toEqual(second);
      expect(first).not.toBe(second); // different array instances
    });
  });
});
