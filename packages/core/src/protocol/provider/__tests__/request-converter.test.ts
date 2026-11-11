/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cloneUsage } from '../empty-usage.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runLogger } from '../../../utils/runLogger.js';
import {
  convertMessages,
  ensureToolResultPairing,
  normalizeMessagesForAPI,
  NON_VISION_IMAGE_PLACEHOLDER,
} from '../request-converter.js';
import { prependUserContext } from '../../../prompts/context-injection.js';
import type {
  ModelStreamAssistantMessage,
  ModelStreamMessage,
  ModelStreamToolCall,
  ModelStreamToolResultContent,
  ModelStreamToolResultMessage,
} from '../../../provider/modelStreamRequest.js';
import type {
  Message,
  UserMessage,
  AssistantMessage,
  AttachmentMessage,
  ImageBlockParam,
} from '../../transcript/message.js';
import {
  EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../../../tools/tool-names.js';

// ---------------------------------------------------------------------------
// Helper: extract messages by role
// ---------------------------------------------------------------------------

function byRole<R extends ModelStreamMessage['role']>(
  msgs: ModelStreamMessage[],
  role: R,
): Array<Extract<ModelStreamMessage, { role: R }>> {
  return msgs.filter(
    (m): m is Extract<ModelStreamMessage, { role: R }> => m.role === role,
  );
}

function blocks(message: ModelStreamMessage | undefined) {
  if (!message) throw new Error('应存在标准请求消息');
  return typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;
}

function textAt(message: ModelStreamMessage | undefined, index = 0): string {
  const block = blocks(message)[index];
  if (block?.type !== 'text') throw new Error('应在指定位置输出标准文本块');
  return block.text;
}

function assistantCalls(
  toolCalls: readonly ModelStreamToolCall[],
  content: ModelStreamAssistantMessage['content'] = [],
): ModelStreamAssistantMessage {
  return { role: 'assistant', content, toolCalls };
}

function call(
  id: string,
  name = 'Bash',
  argumentsJson = '{}',
): ModelStreamToolCall {
  return { id, name, arguments: argumentsJson };
}

function toolResult(
  toolCallId: string,
  content: ModelStreamToolResultContent,
): ModelStreamToolResultMessage {
  return { role: 'tool', toolCallId, content };
}

/**
 * The reported failure mode: the provider numbers tool_call ids per response, so
 * `Bash_0` comes back on every turn already paired with its result.
 *
 * `idFor` lets a test occupy a range of the suffixes the rewrite would generate.
 */
function buildReusedIdHistory(
  turns: number,
  idFor: (turn: number) => string = () => 'Bash_0',
): ModelStreamMessage[] {
  return Array.from({ length: turns }, (_, turn) => {
    const id = idFor(turn);
    return [
      assistantCalls([call(id, 'Bash', JSON.stringify({ turn }))]),
      toolResult(id, `output-${turn}`),
    ];
  }).flat();
}

/**
 * Two turns reusing id `call`, where the second turn's results also contain an
 * upstream id shaped like one the rewrite generates (`call_dup2`).
 */
function buildCollidingOrphanHistory(
  secondTurnResults: readonly ModelStreamToolResultMessage[],
): ModelStreamMessage[] {
  return [
    assistantCalls([call('call')]),
    toolResult('call', 'first'),
    assistantCalls([call('call')]),
    toolResult('call_dup2', 'stale orphan'),
    ...secondTurnResults,
  ];
}

// ===========================================================================
// ensureToolResultPairing
// ===========================================================================

describe('ensureToolResultPairing', () => {
  it('保留已配对的标准调用和结果', () => {
    const messages = [
      assistantCalls([call('tu-1', 'read')]),
      toolResult('tu-1', 'ok'),
    ];
    expect(ensureToolResultPairing(messages)).toEqual(messages);
  });

  it('在后续用户输入之前补齐中断结果', () => {
    const user: ModelStreamMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
    };
    const result = ensureToolResultPairing([
      assistantCalls([call('tu-orphan', 'shell')]),
      user,
    ]);
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tu-orphan',
      isError: true,
    });
    expect(result[2]).toBe(user);
  });

  it('为末尾调用创建独立的中断结果消息', () => {
    const result = ensureToolResultPairing([
      assistantCalls([call('tu-last', 'write')]),
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tu-last',
      isError: true,
    });
  });

  it('将缺失结果放在本轮已有结果之前', () => {
    const existing = toolResult('tu-a', 'ok');
    const result = ensureToolResultPairing([
      assistantCalls([call('tu-a'), call('tu-b')]),
      existing,
    ]);
    expect(byRole(result, 'tool')).toEqual([
      {
        role: 'tool',
        toolCallId: 'tu-b',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: tool execution was interrupted (stream truncated)',
          },
        ],
      },
      existing,
    ]);
  });

  it('保留不含调用的字符串消息', () => {
    const messages: ModelStreamMessage[] = [
      { role: 'assistant', content: 'just text' },
      { role: 'user', content: 'reply' },
    ];
    expect(ensureToolResultPairing(messages)).toEqual(messages);
  });

  it('补齐结果不将纯文本用户输入转换为混合内容', () => {
    const result = ensureToolResultPairing([
      assistantCalls([call('tu-x', 'shell')]),
      { role: 'user', content: 'plain string' },
    ]);
    expect(result[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tu-x',
      isError: true,
    });
    expect(result[2]).toEqual({ role: 'user', content: 'plain string' });
  });

  it('不修改冻结的消息、调用和用户内容', () => {
    const originalUserContent = Object.freeze([
      Object.freeze({ type: 'text' as const, text: 'continue' }),
    ]);
    const assistant = Object.freeze(
      assistantCalls(Object.freeze([Object.freeze(call('tu-mut', 'shell'))])),
    );
    const user = Object.freeze({
      role: 'user' as const,
      content: originalUserContent,
    });
    const messages = Object.freeze([assistant, user]);
    const saved = structuredClone(messages);
    const result = ensureToolResultPairing(messages);
    expect(result[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tu-mut',
      isError: true,
    });
    expect(result[2]).toBe(user);
    expect(messages).toEqual(saved);
    expect(user.content).toBe(originalUserContent);
  });

  // -- Pass 1: Deduplicate tool_use IDs --

  it('跨轮重写重复 ID 并保留参数、正文和真实结果', () => {
    const messages = [
      assistantCalls(
        [call('tu-dup', 'read', '{"v":1}')],
        [{ type: 'text', text: 'first turn' }],
      ),
      toolResult('tu-dup', 'result-1'),
      assistantCalls([call('tu-dup', 'read', '{"v":2}')]),
      toolResult('tu-dup', 'result-2'),
    ];
    const saved = structuredClone(messages);
    const result = ensureToolResultPairing(messages);
    expect(byRole(result, 'assistant')).toEqual([
      assistantCalls(
        [call('tu-dup', 'read', '{"v":1}')],
        [{ type: 'text', text: 'first turn' }],
      ),
      assistantCalls([call('tu-dup_dup2', 'read', '{"v":2}')]),
    ]);
    expect(byRole(result, 'tool')).toEqual([
      toolResult('tu-dup', 'result-1'),
      toolResult('tu-dup_dup2', 'result-2'),
    ]);
    expect(messages).toEqual(saved);
  });

  it.each([true, false])(
    '重写后的 ID 不会认领碰撞的孤立结果（真实结果：%s）',
    (hasResult) => {
      const result = ensureToolResultPairing(
        buildCollidingOrphanHistory(
          hasResult ? [toolResult('call', 'real second result')] : [],
        ),
      );
      expect(byRole(result, 'assistant')[1].toolCalls?.[0].id).toBe(
        'call_dup2',
      );
      const repaired = byRole(result, 'tool');
      expect(repaired).toHaveLength(2);
      expect(repaired[1]).toMatchObject({
        role: 'tool',
        toolCallId: 'call_dup2',
      });
      if (hasResult)
        expect(repaired[1]).toEqual(
          toolResult('call_dup2', 'real second result'),
        );
      else expect(repaired[1].isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('stale orphan');
    },
  );

  it('按响应复用调用 ID 时仍保留每轮参数和结果', () => {
    const result = ensureToolResultPairing(buildReusedIdHistory(4));
    expect(result).toHaveLength(8);
    const assistants = byRole(result, 'assistant');
    const tools = byRole(result, 'tool');
    const ids = assistants.flatMap(
      (message) => message.toolCalls?.map((entry) => entry.id) ?? [],
    );
    expect(new Set(ids).size).toBe(4);
    for (let turn = 0; turn < 4; turn++) {
      expect(assistants[turn].toolCalls?.[0].arguments).toBe(
        JSON.stringify({ turn }),
      );
      expect(tools[turn]).toEqual(toolResult(ids[turn], `output-${turn}`));
    }
  });

  it('历史增长和结果到达后保留稳定的重写前缀', () => {
    const shortRun = ensureToolResultPairing(buildReusedIdHistory(3));
    expect(
      ensureToolResultPairing(buildReusedIdHistory(5)).slice(
        0,
        shortRun.length,
      ),
    ).toEqual(shortRun);
    const settled = buildCollidingOrphanHistory([toolResult('call', 'second')]);
    expect(
      byRole(ensureToolResultPairing(settled.slice(0, 3)), 'assistant')[1]
        .toolCalls,
    ).toEqual(
      byRole(ensureToolResultPairing(settled), 'assistant')[1].toolCalls,
    );
  });

  it('后缀探测跳过已占用区间且不重复扫描', () => {
    const occupied = 100;
    const rewrites = 5;
    const messages = [
      ...buildReusedIdHistory(1),
      ...buildReusedIdHistory(occupied, (turn) => `Bash_0_dup${turn + 2}`),
      ...buildReusedIdHistory(rewrites),
    ];
    const secondPick = `Bash_0_dup${occupied + 3}`;
    const spy = vi.spyOn(Set.prototype, 'has');
    try {
      const result = ensureToolResultPairing(messages);
      const probes = spy.mock.calls.filter(
        ([value]) => value === secondPick,
      ).length;
      expect(
        byRole(result, 'assistant')
          .flatMap((message) => message.toolCalls ?? [])
          .slice(-rewrites)
          .map((entry) => entry.id),
      ).toEqual(
        Array.from(
          { length: rewrites },
          (_, index) => `Bash_0_dup${occupied + 2 + index}`,
        ),
      );
      expect(probes).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('只保留本轮首个调用和首个匹配结果，不丢弃用户正文', () => {
    const first = call('tu-x', 'read', '{"v":1}');
    const user: ModelStreamMessage = { role: 'user', content: 'continue' };
    const result = ensureToolResultPairing([
      toolResult('head-orphan', 'discard'),
      assistantCalls(
        [first, call('tu-x', 'read', '{"v":2}')],
        [{ type: 'text', text: 'some text' }],
      ),
      toolResult('tu-x', 'first'),
      toolResult('tu-x', 'duplicate'),
      toolResult('stale', 'discard'),
      user,
    ]);
    expect(result).toEqual([
      assistantCalls([first], [{ type: 'text', text: 'some text' }]),
      toolResult('tu-x', 'first'),
      user,
    ]);
  });

  it('合并去重、孤立结果删除和缺失结果补齐', () => {
    const result = ensureToolResultPairing([
      assistantCalls([call('tu-dup')]),
      toolResult('tu-dup', 'v1'),
      toolResult('tu-ghost', 'stale'),
      assistantCalls([call('tu-dup'), call('tu-new')]),
      toolResult('tu-dup', 'v2'),
    ]);
    expect(byRole(result, 'tool')).toEqual([
      toolResult('tu-dup', 'v1'),
      {
        role: 'tool',
        toolCallId: 'tu-new',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: tool execution was interrupted (stream truncated)',
          },
        ],
      },
      toolResult('tu-dup_dup2', 'v2'),
    ]);
  });

  it('保留不同调用的独立结果消息与顺序', () => {
    const messages = [
      assistantCalls([call('tu-a'), call('tu-b')]),
      toolResult('tu-a', 'a'),
      toolResult('tu-b', 'b'),
    ];
    expect(ensureToolResultPairing(messages)).toEqual(messages);
  });
});

// ===========================================================================
// convertMessages — user messages
// ===========================================================================

const CACHE = { type: 'ephemeral' } as const;

describe('convertMessages — user messages', () => {
  it('保留标准字符串用户内容', () => {
    const result = convertMessages([{ role: 'user', content: 'hello' }]);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps text blocks separate and marks the last one as cache breakpoint', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second', cacheControl: CACHE },
        ],
      },
    ]);
  });

  it('converts base64 image blocks to inline image sources', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'iVBOR...',
            },
          },
        ],
      },
    ]);
    expect(result[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'iVBOR...' },
        cacheControl: CACHE,
      },
    ]);
  });

  it('does not emit unsupported SVG data on the provider path', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/svg+xml',
              data: 'PHN2Zz48L3N2Zz4=',
            },
          },
        ],
      },
    ]);

    expect(result[0].content).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
        cacheControl: CACHE,
      },
    ]);
  });

  it('converts URL image blocks', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/img.png' },
          },
        ],
      },
    ]);
    expect(result[0].content).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/img.png' },
        cacheControl: CACHE,
      },
    ]);
  });

  it('保留标准 data URL 图片源供 Transport 映射', () => {
    const result = convertMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'data:image/png;base64,abc' },
          },
          { type: 'text', text: 'see above' },
        ],
      },
    ]);
    expect(result[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'data:image/png;base64,abc' },
      },
      { type: 'text', text: 'see above', cacheControl: CACHE },
    ]);
  });

  it('保留标准工具结果在用户正文之前的顺序', () => {
    const result = convertMessages([
      assistantCalls([call('tu-1', READ_FILE_TOOL_NAME)]),
      {
        role: 'tool',
        toolCallId: 'tu-1',
        content: [{ type: 'text', text: 'result text' }],
        isError: true,
      },
      { role: 'user', content: [{ type: 'text', text: 'please continue' }] },
    ]);
    expect(result.slice(1)).toEqual([
      {
        role: 'tool',
        toolCallId: 'tu-1',
        content: [{ type: 'text', text: 'result text' }],
        isError: true,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'please continue', cacheControl: CACHE },
        ],
      },
    ]);
  });

  it('保留标准工具结果的文本块顺序及缓存断点', () => {
    const result = convertMessages([
      assistantCalls([call('tu-2', READ_FILE_TOOL_NAME)]),
      toolResult('tu-2', [
        { type: 'text', text: 'part1' },
        { type: 'text', text: 'part2' },
      ]),
    ]);
    expect(byRole(result, 'tool')[0].content).toEqual([
      { type: 'text', text: 'part1' },
      { type: 'text', text: 'part2', cacheControl: CACHE },
    ]);
  });

  it('不重新投影已准备好的用户消息', () => {
    const message: ModelStreamMessage = { role: 'user', content: [] };
    expect(convertMessages([message])).toEqual([message]);
  });

  it('删除头部孤立工具结果时不创建虚构用户消息', () => {
    expect(convertMessages([toolResult('tu-ghost', 'orphan')])).toEqual([]);
  });

  it('删除正文响应后的孤立工具结果时保留 assistant', () => {
    expect(
      convertMessages([
        { role: 'assistant', content: 'done' },
        toolResult('tu-stale', 'stale'),
      ]),
    ).toEqual([{ role: 'assistant', content: 'done' }]);
  });

  it('保留标准文本块的 cacheControl 和 TTL', () => {
    const result = convertMessages(
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached',
              cacheControl: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
      ],
      false,
    );
    expect(result[0].content).toEqual([
      {
        type: 'text',
        text: 'cached',
        cacheControl: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });
});

// ===========================================================================
// convertMessages — assistant messages
// ===========================================================================

describe('convertMessages — assistant messages', () => {
  it('保留标准字符串 assistant 内容', () => {
    expect(convertMessages([{ role: 'assistant', content: 'hello' }])).toEqual([
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('保留标准 toolCalls 与 JSON 参数', () => {
    const result = convertMessages([
      assistantCalls([
        call(
          'tu-abc',
          READ_FILE_TOOL_NAME,
          JSON.stringify({ path: '/test.ts' }),
        ),
      ]),
    ]);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [],
      toolCalls: [
        {
          id: 'tu-abc',
          name: READ_FILE_TOOL_NAME,
          arguments: JSON.stringify({ path: '/test.ts' }),
        },
      ],
    });
  });

  it('keeps thinking, redacted_thinking and text in their original order', () => {
    const result = convertMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Let me think...',
            signature: 'sig-123',
          },
          { type: 'redacted_thinking', data: 'encrypted-blob' },
          { type: 'text', text: 'Here is my answer' },
        ],
      },
    ]);
    expect(result[0].content).toEqual([
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig-123' },
      { type: 'redacted_thinking', data: 'encrypted-blob' },
      { type: 'text', text: 'Here is my answer', cacheControl: CACHE },
    ]);
  });

  it('标准消息中的空签名不会触发内部格式投影', () => {
    const result = convertMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: '' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);
    expect(result[0].content).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: '' },
      { type: 'text', text: 'answer', cacheControl: CACHE },
    ]);
  });

  it('carries provider reasoning metadata on the thinking block', () => {
    const reasoningItem = {
      id: 'rs-summary-only',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Provider summary' }],
    };
    const result = convertMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Provider summary',
            reasoning: reasoningItem,
          },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);

    expect(result[0].content).toContainEqual({
      type: 'thinking',
      thinking: 'Provider summary',
      reasoning: reasoningItem,
    });
  });

  it('keeps reasoning metadata paired with ciphertext of the same redacted block', () => {
    const result = convertMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'redacted_thinking',
            data: 'encrypted-a',
            reasoning: { id: 'id-a' },
          },
          { type: 'redacted_thinking', data: 'encrypted-b' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);

    expect(result[0].content).toEqual([
      {
        type: 'redacted_thinking',
        data: 'encrypted-a',
        reasoning: { id: 'id-a' },
      },
      { type: 'redacted_thinking', data: 'encrypted-b' },
      { type: 'text', text: 'answer', cacheControl: CACHE },
    ]);
  });

  it('原样保留工具调用的 JSON 文本', () => {
    const result = convertMessages([
      assistantCalls([call('tu-1', 'shell', '{"command":"ls"}')]),
    ]);
    expect(byRole(result, 'assistant')[0].toolCalls).toEqual([
      { id: 'tu-1', name: 'shell', arguments: '{"command":"ls"}' },
    ]);
  });

  it('保留多个标准工具调用的顺序和正文', () => {
    const result = convertMessages(
      [
        assistantCalls(
          [call('tu-1', 'read'), call('tu-2', 'write'), call('tu-3', 'shell')],
          [{ type: 'text', text: 'between' }],
        ),
        toolResult('tu-1', 'read result'),
        toolResult('tu-2', 'write result'),
        toolResult('tu-3', 'shell result'),
      ],
      true,
    );
    const [assistant] = byRole(result, 'assistant');
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual([
      'tu-1',
      'tu-2',
      'tu-3',
    ]);
    expect(assistant.content).toEqual([{ type: 'text', text: 'between' }]);
  });

  it('不重新改写标准工具调用的名称', () => {
    const result = convertMessages([
      assistantCalls([call('tu-1', 'my-tool_v2')]),
    ]);
    expect(byRole(result, 'assistant')[0].toolCalls?.[0].name).toBe(
      'my-tool_v2',
    );
  });
});

// ===========================================================================
// convertMessages — full conversation flow
// ===========================================================================

describe('convertMessages — full conversation flow', () => {
  it('保留标准用户、assistant、工具结果与后续输入的多轮顺序', () => {
    const result = convertMessages([
      { role: 'user', content: 'Read test.ts' },
      assistantCalls(
        [call('tu-1', READ_FILE_TOOL_NAME, '{"path":"test.ts"}')],
        [{ type: 'text', text: 'I will read that file.' }],
      ),
      toolResult('tu-1', 'file contents here'),
      { role: 'user', content: [{ type: 'text', text: 'What does it do?' }] },
    ]);

    expect(result.map((msg) => msg.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(byRole(result, 'assistant')[0].toolCalls).toHaveLength(1);
    expect(byRole(result, 'tool')[0].toolCallId).toBe('tu-1');
  });

  it('handles orphan tool_use repair in full conversation', () => {
    const result = convertMessages([
      assistantCalls([call('tu-orphan', 'shell')]),
      { role: 'user', content: 'what happened?' },
    ]);

    // assistant + tool (synthetic) + user
    expect(result.map((msg) => msg.role)).toEqual([
      'assistant',
      'tool',
      'user',
    ]);
    expect(byRole(result, 'tool')[0]).toMatchObject({
      toolCallId: 'tu-orphan',
      isError: true,
    });
  });

  it('保留标准 system 消息，不引入未知角色兼容', () => {
    const messages: ModelStreamMessage[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hello' },
    ];
    expect(convertMessages(messages)).toEqual(messages);
  });
});

// ===========================================================================
// convertMessages — tool_result multimodal content
// ===========================================================================

function toolResultHistory(
  id: string,
  content: ModelStreamToolResultContent,
): ModelStreamMessage[] {
  return [assistantCalls([call(id, 'screenshot')]), toolResult(id, content)];
}

describe('convertMessages — tool_result multimodal content', () => {
  it('keeps base64 image blocks on the role=tool message', () => {
    const result = convertMessages(
      toolResultHistory('tu-img', [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
        },
      ]),
    );
    expect(byRole(result, 'tool')[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
        cacheControl: CACHE,
      },
    ]);
  });

  it('keeps URL image blocks on the role=tool message', () => {
    const result = convertMessages(
      toolResultHistory('tu-img2', [
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/screenshot.png' },
        },
      ]),
    );
    expect(byRole(result, 'tool')[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/screenshot.png' },
        cacheControl: CACHE,
      },
    ]);
  });

  it('preserves mixed text and image blocks in tool_result order', () => {
    const result = convertMessages(
      toolResultHistory('tu-mixed', [
        { type: 'text', text: 'Screenshot: ' },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/jpeg',
            data: 'jpegdata',
          },
        },
      ]),
    );
    expect(byRole(result, 'tool')[0].content).toEqual([
      { type: 'text', text: 'Screenshot: ' },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: 'jpegdata' },
        cacheControl: CACHE,
      },
    ]);
  });

  describe('supportsVision: false', () => {
    const userImageHistory: ModelStreamMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: 'abc',
            },
          },
        ],
      },
    ];

    it('downgrades user image blocks to a text placeholder', () => {
      const result = convertMessages(userImageHistory, false, {
        supportsVision: false,
      });

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'text',
              text: NON_VISION_IMAGE_PLACEHOLDER,
              cacheControl: CACHE,
            },
          ],
        },
      ]);
    });

    it('keeps image blocks when the model supports vision', () => {
      const result = convertMessages(userImageHistory, false, {
        supportsVision: true,
      });

      expect(result[0].content).toEqual([
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
          cacheControl: CACHE,
        },
      ]);
    });

    it('defaults to passing images through when no option is given', () => {
      const result = convertMessages(userImageHistory);

      expect(result[0].content).toContainEqual(
        expect.objectContaining({ type: 'image' }),
      );
    });

    it('keeps an image-only user turn alive as a text-only message', () => {
      const result = convertMessages(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.com/img.png' },
              },
            ],
          },
        ],
        false,
        { supportsVision: false },
      );

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: NON_VISION_IMAGE_PLACEHOLDER,
              cacheControl: CACHE,
            },
          ],
        },
      ]);
    });

    it('collapses tool_result image content into a text block', () => {
      const result = convertMessages(
        toolResultHistory('tu-novl', [
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
          },
        ]),
        false,
        { supportsVision: false },
      );

      expect(byRole(result, 'tool')[0]).toEqual({
        role: 'tool',
        toolCallId: 'tu-novl',
        content: [
          {
            type: 'text',
            text: NON_VISION_IMAGE_PLACEHOLDER,
            cacheControl: CACHE,
          },
        ],
      });
    });

    it('emits no image block anywhere in the converted history', () => {
      const result = convertMessages(
        [
          ...userImageHistory,
          { role: 'assistant', content: 'noted' },
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  mediaType: 'image/jpeg',
                  data: 'jpegdata',
                },
              },
              { type: 'text', text: 'continue' },
            ],
          },
        ],
        false,
        { supportsVision: false },
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('"image"');
      expect(serialized).not.toContain('base64');
    });
  });

  it.each(['image/png', 'image/svg+xml'])(
    '图片降级保留非末尾块的缓存 TTL（%s）',
    (mediaType) => {
      const image: ModelStreamMessage = {
        role: 'user',
        content: Object.freeze([
          Object.freeze({
            type: 'image',
            source: Object.freeze({ type: 'base64', mediaType, data: 'abc' }),
            cacheControl: Object.freeze({ type: 'ephemeral', ttl: '1h' }),
          }),
        ]),
      };
      const history = Object.freeze([
        image,
        { role: 'assistant' as const, content: 'noted' },
      ]);
      const saved = structuredClone(history);
      const result = convertMessages(history, false, { supportsVision: false });
      expect(blocks(result[0])[0]).toMatchObject({
        type: 'text',
        cacheControl: { type: 'ephemeral', ttl: '1h' },
      });
      expect(history).toEqual(saved);
    },
  );

  it('保留标准空工具结果，不使用缺失正文或非法图片兼容', () => {
    const result = convertMessages(toolResultHistory('tu-empty', []));
    expect(byRole(result, 'tool')[0]).toEqual(toolResult('tu-empty', []));
  });
});

// ===========================================================================
// normalizeMessagesForAPI — integration tests with Message[] input
// ===========================================================================

// Helpers for constructing Message objects
function makeUserMsg(content: UserMessage['message']['content']): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
  };
}

function makeAssistantMsg(
  content: AssistantMessage['message']['content'],
  overrides?: Partial<AssistantMessage['message']>,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: randomUUID(),

      model: 'test',
      stop_reason: 'end_turn',

      usage: {
        ...cloneUsage(),
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,

      ...overrides,
    },
  };
}

function makeAttachmentMsg(
  attachment: AttachmentMessage['attachment'],
): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment,
  };
}

describe('convertMessages — request image limit', () => {
  const placeholder = '[media removed: request limit]';
  const image = (index: number) => ({
    type: 'image' as const,
    source: {
      type: 'url' as const,
      url: `https://example.test/page-${index}.png`,
    },
  });
  const images = (count: number, start = 0) =>
    Array.from({ length: count }, (_, index) => image(start + index));
  const imageUrls = (messages: readonly ModelStreamMessage[]) =>
    messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === 'image'
              ? [
                  part.source.type === 'url'
                    ? part.source.url
                    : `data:${part.source.mediaType};base64,${part.source.data}`,
                ]
              : [],
          )
        : [],
    );

  it.each([
    [0, 0],
    [1, 1],
    [49, 49],
    [50, 50],
    [51, 30],
    [52, 31],
    [71, 50],
    [72, 30],
    [101, 38],
  ])(
    'retains the newest images for %i input images (%i retained)',
    (count, retained) => {
      const content: UserMessage['message']['content'] = [
        { type: 'text', text: 'Inspect these pages' },
        ...images(count),
      ];
      const result = convertMessages(
        normalizeMessagesForAPI([makeUserMsg(content)]),
      );
      expect(imageUrls(result)).toEqual(
        images(retained, count - retained).map((block) =>
          block.source.type === 'url' ? block.source.url : '',
        ),
      );
      expect(JSON.stringify(result)).toContain('Inspect these pages');
    },
  );

  it.each([
    [100, 100, 100],
    [100, 101, 60],
    [100, 141, 100],
    [100, 142, 60],
    [3, 4, 2],
    [1, 2, 1],
  ])(
    'uses configured limit %i for %i images (%i retained)',
    (maxRequestImages, count, retained) => {
      const input: ModelStreamMessage[] = [
        { role: 'user', content: images(count) },
      ];
      expect(
        imageUrls(convertMessages(input, false, { maxRequestImages })),
      ).toEqual(
        images(retained, count - retained).map((block) => block.source.url),
      );
    },
  );

  describe('image trimming diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      [51, 21, 30],
      [52, 21, 31],
      [72, 42, 30],
      [101, 63, 38],
    ])('logs totals once for %i images', (original, removed, retained) => {
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      convertMessages(normalizeMessagesForAPI([makeUserMsg(images(original))]));
      expect(log).toHaveBeenCalledExactlyOnceWith(
        '[RequestConverter] Trimmed request history images',
        { original, removed, retained },
      );
    });

    it.each([0, 49, 50])(
      'does not log when %i images need no trimming',
      (count) => {
        const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
        convertMessages(
          normalizeMessagesForAPI([
            makeUserMsg([{ type: 'text', text: 'Inspect' }, ...images(count)]),
          ]),
        );
        expect(log).not.toHaveBeenCalled();
      },
    );

    it('does not log trimming for a non-vision model', () => {
      const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
      convertMessages(
        normalizeMessagesForAPI([makeUserMsg(images(51))]),
        false,
        {
          supportsVision: false,
        },
      );
      expect(log).not.toHaveBeenCalled();
    });
  });

  it('preserves tool pairs, text and original history across PDF page reads', () => {
    const history: Message[] = Array.from({ length: 52 }, (_, index) => [
      makeAssistantMsg([
        {
          type: 'tool_use',
          id: `read-${index}`,
          name: READ_FILE_TOOL_NAME,
          input: { pages: `${index + 1}` },
        },
      ]),
      makeUserMsg([
        { type: 'text', text: `Turn ${index}` },
        {
          type: 'tool_result',
          tool_use_id: `read-${index}`,
          content: [{ type: 'text', text: `Page ${index + 1}` }, image(index)],
        },
      ]),
    ]).flat();
    const original = structuredClone(history);
    const normalized = normalizeMessagesForAPI(history);
    const originalProjection = structuredClone(normalized);
    const result = convertMessages(normalized);

    expect(imageUrls(result)).toEqual(
      images(31, 21).map((block) =>
        block.source.type === 'url' ? block.source.url : '',
      ),
    );
    const tools = byRole(result, 'tool');
    expect(tools).toHaveLength(52);
    for (let index = 0; index < 52; index++) {
      expect(tools[index].toolCallId).toBe(`read-${index}`);
      expect(JSON.stringify(tools[index].content)).toContain(
        `Page ${index + 1}`,
      );
      expect(JSON.stringify(result)).toContain(`Turn ${index}`);
      expect(byRole(result, 'assistant')[index].toolCalls?.[0].id).toBe(
        `read-${index}`,
      );
      if (index < 21)
        expect(JSON.stringify(tools[index].content)).toContain(placeholder);
    }
    expect(normalized).toEqual(originalProjection);
    expect(history).toEqual(original);
    expect(convertMessages(normalizeMessagesForAPI(history))).toEqual(result);
  });

  it('counts top-level base64 and nested URL images together in history order', () => {
    const base64Images: ImageBlockParam[] = images(20).map((_, index) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from(`image-${index}`).toString('base64'),
      },
    }));
    const result = convertMessages(
      normalizeMessagesForAPI([
        makeUserMsg([
          { type: 'text', text: 'Keep this text' },
          ...base64Images,
        ]),
        makeAssistantMsg([
          {
            type: 'tool_use',
            id: 'read',
            name: READ_FILE_TOOL_NAME,
            input: {},
          },
        ]),
        makeUserMsg([
          { type: 'tool_result', tool_use_id: 'read', content: images(32, 20) },
        ]),
      ]),
    );
    expect(imageUrls(result)).toEqual(
      images(31, 21).map((block) =>
        block.source.type === 'url' ? block.source.url : '',
      ),
    );
    expect(textAt(byRole(result, 'user')[0])).toBe('Keep this text');
    expect(blocks(byRole(result, 'tool')[0])[0]).toEqual({
      type: 'text',
      text: placeholder,
    });
  });

  it('keeps a placeholder when an entire image-only user turn is removed', () => {
    const result = convertMessages(
      normalizeMessagesForAPI([
        makeUserMsg(images(21)),
        makeAssistantMsg([{ type: 'text', text: 'Continue', citations: null }]),
        makeUserMsg(images(30, 21)),
      ]),
    );
    expect(textAt(result[0])).toBe(placeholder);
    expect(imageUrls(result)).toHaveLength(30);
  });

  it('preserves standard role, tool metadata, reasoning and retained image sources', () => {
    const retainedImages = Array.from({ length: 32 }, (_, index) => ({
      type: 'image' as const,
      source:
        index % 2 === 0
          ? {
              type: 'base64' as const,
              mediaType: 'image/png',
              data: Buffer.from(`tool-${index}`).toString('base64'),
            }
          : {
              type: 'url' as const,
              url: `https://example.test/tool-${index}.png`,
            },
    }));
    const assistant: ModelStreamAssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'reasoning',
          signature: 'original-signature',
        },
        {
          type: 'redacted_thinking',
          data: 'opaque-data',
          reasoning: { id: 'reasoning-id' },
        },
      ],
      toolCalls: [call('read', READ_FILE_TOOL_NAME, '{"pages":"1-32"}')],
    };
    const input: ModelStreamMessage[] = [
      { role: 'user', content: images(20) },
      assistant,
      {
        role: 'tool',
        toolCallId: 'read',
        isError: false,
        content: [{ type: 'text', text: 'pages' }, ...retainedImages],
      },
      { role: 'user', content: 'Keep going' },
    ];
    const before = structuredClone(input);
    const result = convertMessages(input, true);
    expect(result.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(textAt(result[0])).toBe(placeholder);
    expect(result[1]).toEqual(assistant);
    expect(result[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'read',
      isError: false,
    });
    expect(blocks(result[2])).toEqual([
      { type: 'text', text: 'pages' },
      { type: 'text', text: placeholder },
      ...retainedImages.slice(1, -1),
      { ...retainedImages.at(-1), cacheControl: { type: 'ephemeral' } },
    ]);
    expect(result[3]).toEqual(input[3]);
    expect(input).toEqual(before);
  });

  it('limits combined pre-projected history and newly normalized suffixes', () => {
    const prefix = normalizeMessagesForAPI([makeUserMsg(images(49))]);
    const suffix = normalizeMessagesForAPI([makeUserMsg(images(3, 49))]);
    expect(imageUrls(convertMessages([...prefix, ...suffix]))).toEqual(
      images(31, 21).map((block) =>
        block.source.type === 'url' ? block.source.url : '',
      ),
    );
  });

  it('counts expanded image attachments without modifying them', () => {
    const history = [
      makeUserMsg('Inspect the attachments'),
      ...images(51).map((_, index) =>
        makeAttachmentMsg({
          type: 'image_file',
          filename: `/tmp/page-${index}.png`,
          displayPath: `/tmp/page-${index}.png`,
          mediaType: 'image/png',
          base64: Buffer.from(`page-${index}`).toString('base64'),
        } as unknown as AttachmentMessage['attachment']),
      ),
    ];
    const original = structuredClone(history);
    expect(
      imageUrls(convertMessages(normalizeMessagesForAPI(history))),
    ).toHaveLength(30);
    expect(history).toEqual(original);
  });

  it('does not count images stripped during normalization', () => {
    const result = convertMessages(
      normalizeMessagesForAPI([
        makeAssistantMsg([
          {
            type: 'tool_use',
            id: 'failed',
            name: READ_FILE_TOOL_NAME,
            input: {},
          },
        ]),
        makeUserMsg([
          {
            type: 'tool_result',
            tool_use_id: 'failed',
            is_error: true,
            content: [image(100)],
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/svg+xml',
              data: 'PHN2Zy8+',
            },
          },
          ...images(50),
        ]),
      ]),
    );
    expect(imageUrls(result)).toEqual(
      images(50).map((block) =>
        block.source.type === 'url' ? block.source.url : '',
      ),
    );
    expect(JSON.stringify(result)).not.toContain(placeholder);
  });

  it('does not count orphan tool results removed before wire conversion', () => {
    const result = convertMessages(
      normalizeMessagesForAPI([
        makeUserMsg([
          { type: 'tool_result', tool_use_id: 'orphan', content: images(30) },
          ...images(50),
        ]),
      ]),
    );
    expect(imageUrls(result)).toHaveLength(50);
  });

  it('preserves non-vision placeholders instead of trimming image-only turns', () => {
    const result = convertMessages(
      normalizeMessagesForAPI([makeUserMsg(images(51))]),
      false,
      { supportsVision: false },
    );
    expect(imageUrls(result)).toEqual([]);
    expect(JSON.stringify(result)).toContain(NON_VISION_IMAGE_PLACEHOLDER);
    expect(JSON.stringify(result)).not.toContain(placeholder);
  });
});

describe('normalizeMessagesForAPI', () => {
  it('历史准备不改写标准 data URL 图片源或缓存 TTL', () => {
    const message = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'data:image/png;base64,abc' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'inspect',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    const saved = structuredClone(message);
    expect(normalizeMessagesForAPI([message])[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'data:image/png;base64,abc' },
        cacheControl: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'inspect',
        cacheControl: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(message).toEqual(saved);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeMessagesForAPI([])).toEqual([]);
  });

  it('将宿主用户正文准备为标准文本块', () => {
    const result = normalizeMessagesForAPI([makeUserMsg('Hello')]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('virtual user messages are filtered out', () => {
    const msg = makeUserMsg('hidden');
    msg.isVirtual = true;
    expect(normalizeMessagesForAPI([msg])).toEqual([]);
  });

  it('preserves the refused user prompt while removing the failed assistant response', () => {
    const priorUser = makeUserMsg('prior prompt');
    const priorAssistant = makeAssistantMsg([
      { type: 'text', text: 'prior response' },
    ]);
    const refusedUser = makeUserMsg('refused prompt');
    const partialAssistant = makeAssistantMsg(
      [{ type: 'text', text: 'partial refused response' }],
      { stop_reason: 'refusal' },
    );
    const refusalMarker = makeAssistantMsg([
      { type: 'text', text: 'content filtered' },
    ]);
    refusalMarker.isContentFilteredMessage = true;
    const nextUser = makeUserMsg('next prompt');

    const result = normalizeMessagesForAPI([
      priorUser,
      priorAssistant,
      refusedUser,
      partialAssistant,
      refusalMarker,
      nextUser,
    ]);

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'prior prompt' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior response' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'refused prompt\n' },
          { type: 'text', text: 'next prompt' },
        ],
      },
    ]);
  });

  it('preserves closed tool facts from before and during the refused response', () => {
    const refusedUser = makeUserMsg('complete the task');
    const toolA = makeAssistantMsg([
      { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
    ]);
    const toolAResult = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tool-a',
        content: 'known result',
      },
    ]);
    const refusedText = makeAssistantMsg(
      [{ type: 'text', text: 'failed explanation' }],
      { id: 'refusal-response', stop_reason: null },
    );
    const toolB = makeAssistantMsg(
      [{ type: 'tool_use', id: 'tool-b', name: 'Write', input: {} }],
      { id: 'refusal-response', stop_reason: 'refusal' },
    );
    const toolBResult = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tool-b',
        content: 'unknown outcome',
        is_error: true,
      },
      {
        type: 'tool_result',
        tool_use_id: 'stale-orphan',
        content: 'must not survive projection',
        is_error: true,
      },
    ]);
    const refusalMarker = makeAssistantMsg([
      { type: 'text', text: 'content filtered' },
    ]);
    refusalMarker.isContentFilteredMessage = true;

    const result = normalizeMessagesForAPI([
      refusedUser,
      toolA,
      toolAResult,
      refusedText,
      toolB,
      toolBResult,
      refusalMarker,
    ]);

    expect(result).toHaveLength(5);
    expect(textAt(result[0])).toBe('complete the task');
    expect(
      byRole(result, 'assistant').map((message) => message.toolCalls),
    ).toEqual([[call('tool-a', 'Read')], [call('tool-b', 'Write')]]);
    expect(byRole(result, 'tool')).toEqual([
      toolResult('tool-a', [{ type: 'text', text: 'known result' }]),
      {
        role: 'tool',
        toolCallId: 'tool-b',
        isError: true,
        content: [{ type: 'text', text: 'unknown outcome' }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('failed explanation');
    expect(JSON.stringify(result)).not.toContain('content filtered');
    expect(JSON.stringify(result)).not.toContain('stale-orphan');
  });

  it('preserves non-tool user content while removing only orphaned tool results', () => {
    const user = makeUserMsg('complete the task');
    const tool = makeAssistantMsg(
      [{ type: 'tool_use', id: 'tool-mixed', name: 'Write', input: {} }],
      { stop_reason: 'refusal' },
    );
    const mixedResult = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tool-mixed',
        content: 'unknown outcome',
        is_error: true,
      },
      {
        type: 'tool_result',
        tool_use_id: 'stale-orphan',
        content: 'must not survive projection',
        is_error: true,
      },
      { type: 'text', text: 'Keep this user continuation.' },
    ]);
    const refusalMarker = makeAssistantMsg([
      { type: 'text', text: 'content filtered' },
    ]);
    refusalMarker.isContentFilteredMessage = true;

    const result = normalizeMessagesForAPI([
      user,
      tool,
      mixedResult,
      refusalMarker,
    ]);

    expect(result.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(result.slice(2)).toEqual([
      {
        role: 'tool',
        toolCallId: 'tool-mixed',
        isError: true,
        content: [{ type: 'text', text: 'unknown outcome' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Keep this user continuation.' }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('stale-orphan');
  });

  it('removes an unpaired tool from a refused response without inventing a result', () => {
    const user = makeUserMsg('complete the task');
    const orphanTool = makeAssistantMsg(
      [{ type: 'tool_use', id: 'orphan', name: 'Write', input: {} }],
      { stop_reason: 'refusal' },
    );
    const refusalMarker = makeAssistantMsg([
      { type: 'text', text: 'content filtered' },
    ]);
    refusalMarker.isContentFilteredMessage = true;

    expect(normalizeMessagesForAPI([user, orphanTool, refusalMarker])).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'complete the task' }],
      },
    ]);
  });

  it('仅凭回复正文不判定 refusal，不兼容旧文本标记', () => {
    const user = makeUserMsg('complete the task');
    const legacyMarker = makeAssistantMsg([
      {
        type: 'text',
        text: "Sorry, I'm unable to answer this question for now. Let's change the topic!",
      },
    ]);

    const result = normalizeMessagesForAPI([user, legacyMarker]);
    expect(result.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(textAt(result[1])).toBe(
      legacyMarker.message.content[0].type === 'text'
        ? legacyMarker.message.content[0].text
        : '',
    );
  });

  it('adjacent user messages are merged', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('part1'),
      makeUserMsg('part2'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
  });

  it('trailing thinking blocks stripped from last assistant', () => {
    const result = normalizeMessagesForAPI([
      makeAssistantMsg([
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'thought', signature: 'sig' },
      ]),
    ]);
    expect(result[0].content).toHaveLength(1);
    expect(blocks(result[0])[0].type).toBe('text');
  });

  it('all-thinking assistant is removed entirely', () => {
    const result = normalizeMessagesForAPI([
      makeAssistantMsg([
        { type: 'thinking', thinking: 'thought', signature: '' },
      ]),
    ]);
    expect(result).toHaveLength(0);
  });

  it('keeps thinking-only assistant when same message.id has non-thinking sibling', () => {
    const thinkingOnly = makeAssistantMsg(
      [{ type: 'thinking', thinking: 'thought', signature: 'sig' }],
      { id: 'msg-with-sibling' },
    );
    const visibleSibling = makeAssistantMsg(
      [{ type: 'text', text: 'visible answer' }],
      { id: 'msg-with-sibling' },
    );

    const result = normalizeMessagesForAPI([
      thinkingOnly,
      makeUserMsg('separator'),
      visibleSibling,
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('assistant');
    expect(blocks(result[0])[0].type).toBe('thinking');
    expect(textAt(result[2])).toBe('visible answer');
  });

  it('removes foreign reasoning metadata while preserving visible context', () => {
    const result = normalizeMessagesForAPI(
      [
        makeAssistantMsg(
          [
            {
              type: 'thinking',
              thinking: 'Visible reasoning.',
              signature: 'provider-signature',
              reasoning_item: {
                id: 'reasoning-id',
                summary: [{ type: 'summary_text', text: 'Provider summary.' }],
              },
            },
            {
              type: 'redacted_thinking',
              data: 'encrypted-reasoning',
              reasoning_item: { id: 'reasoning-id' },
            },
            { type: 'text', text: 'Visible answer.' },
          ],
          { model: 'source-model' },
        ),
        makeUserMsg('continue'),
      ],
      {
        targetModel: 'target-model',
        targetCustomProviderId: 'target-provider',
      },
    );

    expect(result[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Visible reasoning.' },
        { type: 'text', text: 'Visible answer.' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('provider-signature');
    expect(JSON.stringify(result)).not.toContain('encrypted-reasoning');
    expect(JSON.stringify(result)).not.toContain('reasoning-id');
  });

  it('preserves reasoning metadata for the producing model', () => {
    const result = normalizeMessagesForAPI(
      [
        makeAssistantMsg(
          [
            {
              type: 'thinking',
              thinking: 'Visible reasoning.',
              signature: 'provider-signature',
            },
            { type: 'text', text: 'Visible answer.' },
          ],
          { model: 'same-model' },
        ),
        makeUserMsg('continue'),
      ],
      { targetModel: 'same-model' },
    );

    expect(blocks(result[0])[0]).toMatchObject({
      type: 'thinking',
      signature: 'provider-signature',
    });
  });

  it('preserves reasoning metadata when models differ within the same custom provider', () => {
    const assistant = makeAssistantMsg(
      [
        {
          type: 'thinking',
          thinking: 'Visible reasoning.',
          signature: 'provider-signature',
        },
        { type: 'text', text: 'Visible answer.' },
      ],
      { model: 'provider-model' },
    );
    assistant.modelSource = 'custom';
    assistant.customProviderId = 'gateway';
    const result = normalizeMessagesForAPI(
      [assistant, makeUserMsg('continue')],
      {
        targetModel: 'gateway/other-model',
        targetCustomProviderId: 'gateway',
      },
    );

    expect(blocks(result[0])[0]).toMatchObject({
      type: 'thinking',
      signature: 'provider-signature',
    });
  });

  it('removes reasoning metadata when custom providers share a wire model ID', () => {
    const assistant = makeAssistantMsg(
      [
        {
          type: 'thinking',
          thinking: 'Visible reasoning.',
          signature: 'provider-a-signature',
        },
        {
          type: 'redacted_thinking',
          data: 'provider-a-encrypted-reasoning',
        },
        { type: 'text', text: 'Visible answer.' },
      ],
      { model: 'shared-model' },
    );
    assistant.modelSource = 'custom';
    assistant.customProviderId = 'provider-a';

    const result = normalizeMessagesForAPI(
      [assistant, makeUserMsg('continue')],
      {
        targetModel: 'provider-b/shared-model',
        targetCustomProviderId: 'provider-b',
      },
    );

    expect(result[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Visible reasoning.' },
        { type: 'text', text: 'Visible answer.' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('provider-a-signature');
    expect(JSON.stringify(result)).not.toContain(
      'provider-a-encrypted-reasoning',
    );
  });

  it('切换直连 provider 时将仅含可见 reasoning 的响应保留为文本', () => {
    const assistant = makeAssistantMsg(
      [
        {
          type: 'thinking',
          thinking: 'Visible reasoning.',
          signature: 'source-signature',
        },
      ],
      { model: 'provider-model' },
    );
    assistant.modelSource = 'custom';
    assistant.customProviderId = 'source-provider';

    const result = normalizeMessagesForAPI(
      [assistant, makeUserMsg('continue')],
      {
        targetModel: 'gateway/provider-model',
        targetCustomProviderId: 'gateway',
      },
    );

    expect(blocks(result[0])[0]).toEqual({
      type: 'text',
      text: 'Visible reasoning.',
    });
    expect(JSON.stringify(result)).not.toContain('source-signature');
  });

  it.each([
    ['platform', undefined],
    ['custom', 'gateway'],
  ] as const)(
    'preserves %s reasoning for a server-routed target',
    (source, providerId) => {
      const assistant = makeAssistantMsg(
        [
          {
            type: 'thinking',
            thinking: 'Visible reasoning.',
            signature: 'signature',
            reasoning_item: {
              id: 'reasoning-id',
              summary: [{ type: 'summary_text', text: 'Summary.' }],
            },
          },
          { type: 'redacted_thinking', data: 'encrypted-reasoning' },
          { type: 'text', text: 'Visible answer.' },
        ],
        { model: 'source-model' },
      );
      if (source === 'custom') assistant.modelSource = 'custom';
      assistant.customProviderId = providerId;
      const original = structuredClone(assistant);
      const result = normalizeMessagesForAPI(
        [assistant, makeUserMsg('continue')],
        { targetModel: 'server-target-model' },
      );
      expect(result[0].content).toEqual([
        {
          type: 'thinking',
          thinking: 'Visible reasoning.',
          signature: 'signature',
          reasoning: {
            id: 'reasoning-id',
            summary: [{ type: 'summary_text', text: 'Summary.' }],
          },
        },
        { type: 'redacted_thinking', data: 'encrypted-reasoning' },
        { type: 'text', text: 'Visible answer.' },
      ]);
      expect(assistant).toEqual(original);
    },
  );

  it('cleans platform reasoning for a direct custom-provider target', () => {
    const result = normalizeMessagesForAPI(
      [
        makeAssistantMsg(
          [
            {
              type: 'thinking',
              thinking: 'Visible reasoning.',
              signature: 'platform-signature',
            },
            { type: 'text', text: 'Visible answer.' },
          ],
          { model: 'provider-model' },
        ),
        makeUserMsg('continue'),
      ],
      {
        targetModel: 'gateway/provider-model',
        targetCustomProviderId: 'gateway',
      },
    );

    expect(result[0].content[0]).toEqual({
      type: 'text',
      text: 'Visible reasoning.',
    });
    expect(JSON.stringify(result)).not.toContain('platform-signature');
  });

  it('whitespace-only assistant is removed and adjacent users merged', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('u1'),
      makeAssistantMsg([{ type: 'text', text: '\n\n' }]),
      makeUserMsg('u2'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('empty non-trailing assistant gets placeholder', () => {
    const result = normalizeMessagesForAPI([
      makeAssistantMsg([]),
      makeUserMsg('follow-up'),
    ]);
    expect(textAt(result[0])).toBe('[No message content]');
  });

  it('attachment messages are expanded', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('hello'),
      makeAttachmentMsg({
        type: 'date_change',
        newDate: '2024-01-02',
      }),
    ]);
    // attachment expands and merges with preceding user message
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    const text = blocks(result[0])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('hello');
  });

  it('reorders raw image attachments before expansion', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('please inspect'),
      makeAttachmentMsg({
        type: 'image_file',
        filename: '/tmp/screenshot.png',
        displayPath: '/tmp/screenshot.png',
        mediaType: 'image/png',
        base64: 'abc',
      }),
      makeAssistantMsg([{ type: 'text', text: 'I can inspect that' }]),
    ]);

    expect(result).toHaveLength(2);
    const content = blocks(result[0]);
    const imageIndex = content.findIndex((block) => block.type === 'image');
    const promptIndex = content.findIndex(
      (block) => block.type === 'text' && block.text === 'please inspect',
    );
    expect(imageIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(imageIndex);
  });

  it('moves task reminders before the current user input', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('continue current work'),
      makeAttachmentMsg({
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: 'Pending work',
            description: 'Continue the work',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      }),
    ]);

    const projectedText = result
      .flatMap((message) =>
        blocks(message).flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      )
      .join('\n');
    const promptIndex = projectedText.indexOf('continue current work');
    const reminderIndex = projectedText.indexOf('#1. [pending] Pending work');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(reminderIndex).toBeLessThan(promptIndex);
  });
});

// ===========================================================================
// convertMessages integration — Message[] input
// ===========================================================================

describe('convertMessages with Message[] input', () => {
  it('expands attachment and produces valid alternating messages', () => {
    const messages: Message[] = [
      makeAssistantMsg([
        { type: 'tool_use', id: 'tu-1', name: 'read', input: {} },
      ]),
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'file content',
          is_error: false,
        },
      ]),
      makeUserMsg('supplementary'),
      makeAttachmentMsg({
        type: 'date_change',
        newDate: '2024-01-02',
      }),
      makeUserMsg('next prompt'),
    ];
    // normalizeMessagesForAPI first, then convertMessages (wire path)
    const normalized = normalizeMessagesForAPI(messages);
    const result = convertMessages(normalized);
    for (let i = 1; i < result.length; i++) {
      if (result[i].role === result[i - 1].role && result[i].role !== 'tool') {
        throw new Error(`Adjacent same-role at index ${i}: ${result[i].role}`);
      }
    }
  });

  it('strips trailing thinking and converts to provider messages', () => {
    const messages: Message[] = [
      makeUserMsg('think hard'),
      makeAssistantMsg([
        { type: 'thinking', thinking: 'let me think', signature: '' },
        { type: 'text', text: 'My answer' },
      ]),
    ];
    // normalizeMessagesForAPI strips trailing thinking (which is NOT trailing here since text follows)
    const normalized = normalizeMessagesForAPI(messages);
    const result = convertMessages(normalized);
    const assistants = result.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBeTruthy();
  });

  it('folds internal system-reminder after tool_result without emitting a user turn', () => {
    const messages: Message[] = [
      makeAssistantMsg([
        { type: 'tool_use', id: 'tu-1', name: READ_FILE_TOOL_NAME, input: {} },
      ]),
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'file content',
          is_error: false,
        },
      ]),
      makeUserMsg('<system-reminder>internal hint</system-reminder>'),
    ];

    const normalized = normalizeMessagesForAPI(messages);
    const result = convertMessages(normalized);

    expect(result.map((msg) => msg.role)).toEqual(['assistant', 'tool']);
    expect(result[1]).toEqual({
      role: 'tool',
      toolCallId: 'tu-1',
      content: [
        {
          type: 'text',
          text: 'file content\n\n<system-reminder>internal hint</system-reminder>',
          cacheControl: CACHE,
        },
      ],
    });
  });
});

// ===========================================================================
// normalizeMessagesForAPI — new feature tests
// ===========================================================================

describe('normalizeMessagesForAPI — joinTextAtSeam', () => {
  it('inserts \\n between adjacent text blocks when merging users', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('2 + 2'),
      makeUserMsg('3 + 3'),
    ]);
    expect(result).toHaveLength(1);
    // Two text blocks, but the first should have \n appended
    expect(blocks(result[0])).toHaveLength(2);
    expect(textAt(result[0])).toBe('2 + 2\n');
    expect(textAt(result[0], 1)).toBe('3 + 3');
  });

  it('does not insert \\n when seam is text-image', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg('hello'),
      makeUserMsg([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        },
      ]),
    ]);
    expect(result).toHaveLength(1);
    expect(textAt(result[0])).toBe('hello');
    expect(blocks(result[0])[1].type).toBe('image');
  });

  it('does not insert \\n when seam is image-text', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        },
      ]),
      makeUserMsg('after image'),
    ]);
    expect(result).toHaveLength(1);
    expect(blocks(result[0])[0].type).toBe('image');
    expect(textAt(result[0], 1)).toBe('after image');
  });
});

describe('normalizeMessagesForAPI — system-reminder tool_result folding', () => {
  it('folds system-reminder text siblings into the last tool_result', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'result text',
          is_error: false,
        },
      ]),
      makeUserMsg('<system-reminder>internal hint</system-reminder>'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      toolResult('tu-1', [
        {
          type: 'text',
          text: 'result text\n\n<system-reminder>internal hint</system-reminder>',
        },
      ]),
    );
  });

  it('folds system-reminder after filtering an intervening thinking-only assistant', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'result text',
          is_error: false,
        },
      ]),
      makeAssistantMsg([
        { type: 'thinking', thinking: 'orphaned thought', signature: 'sig' },
      ]),
      makeUserMsg('<system-reminder>internal hint</system-reminder>'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      toolResult('tu-1', [
        {
          type: 'text',
          text: 'result text\n\n<system-reminder>internal hint</system-reminder>',
        },
      ]),
    );
  });

  it('keeps stream-recovery history paired without synthetic results', () => {
    // Settled call, then a history-only placeholder for an undispatched call
    // with empty input, then the request-level reminder.
    const normalized = normalizeMessagesForAPI([
      makeAssistantMsg([
        { type: 'tool_use', id: 'a', name: 'Write', input: { path: 'a' } },
      ]),
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'a',
          content: 'written once',
          is_error: false,
        },
      ]),
      makeAssistantMsg([
        { type: 'tool_use', id: 'unfinished', name: 'Write', input: {} },
      ]),
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'unfinished',
          content: 'Error: Tool was not executed',
          is_error: true,
        },
      ]),
      makeUserMsg('<system-reminder>interrupted</system-reminder>'),
    ]);
    expect(normalized.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    const wire = convertMessages(normalized);
    expect(wire.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(wire[2]).toMatchObject({
      toolCalls: [
        { id: 'unfinished', name: 'Write', arguments: '{}' },
      ],
    });
    expect(wire[3]).toMatchObject({
      toolCallId: 'unfinished',
      isError: true,
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Error: Tool was not executed'),
        }),
      ]),
    });
    expect(JSON.stringify(wire)).not.toContain('stream truncated');
  });

  it('keeps real user text as a sibling after tool_result', () => {
    const result = normalizeMessagesForAPI([
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'result text',
          is_error: false,
        },
      ]),
      makeUserMsg('now explain'),
    ]);

    expect(result).toEqual([
      toolResult('tu-1', [{ type: 'text', text: 'result text' }]),
      { role: 'user', content: [{ type: 'text', text: 'now explain' }] },
    ]);
  });
});

describe('prependUserContext + normalizeMessagesForAPI', () => {
  it('prepends startup context before normalization so adjacent user turns merge', () => {
    const messages = prependUserContext(
      [makeUserMsg('<system-reminder>hook success</system-reminder>')],
      { currentDate: "Today's date is 2026-05-13." },
    );

    const result = normalizeMessagesForAPI(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('# currentDate'),
      }),
      { type: 'text', text: '<system-reminder>hook success</system-reminder>' },
    ]);
    expect(textAt(result[0])).toMatch(/<\/system-reminder>\n\n$/);
  });
});

describe('normalizeMessagesForAPI — normalizeToolInputForAPI', () => {
  it('strips modified_by_user and ai_proposed_content from tool_use inputs', () => {
    const assistantMsg = makeAssistantMsg([
      {
        type: 'tool_use',
        id: 'tu-strip',
        name: EDIT_TOOL_NAME,
        input: {
          file_path: '/test.ts',
          old_string: 'a',
          new_string: 'b',
          replace_all: true,
          modified_by_user: true,
          ai_proposed_content: 'original',
        },
      },
    ]);
    const result = normalizeMessagesForAPI([assistantMsg]);
    expect(byRole(result, 'assistant')[0].toolCalls).toEqual([
      call(
        'tu-strip',
        EDIT_TOOL_NAME,
        JSON.stringify({
          file_path: '/test.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      ),
    ]);
    expect(assistantMsg.message.content[0]).toMatchObject({
      input: {
        replace_all: true,
        modified_by_user: true,
        ai_proposed_content: 'original',
      },
    });
  });

  it('strips ExitPlanMode confirmation fields but keeps schema fields', () => {
    const assistantMsg = makeAssistantMsg([
      {
        type: 'tool_use',
        id: 'tu-plan',
        name: EXIT_PLAN_MODE_TOOL_NAME,
        input: {
          allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
          plan: 'internal plan text',
          approved: true,
          permissionMode: 'acceptEdits',
          feedback: 'looks good',
          planWasEdited: true,
        },
      },
    ]);
    const result = normalizeMessagesForAPI([assistantMsg]);
    expect(byRole(result, 'assistant')[0].toolCalls).toEqual([
      call(
        'tu-plan',
        EXIT_PLAN_MODE_TOOL_NAME,
        JSON.stringify({
          allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
        }),
      ),
    ]);
  });
});

describe('normalizeMessagesForAPI — assistant backward merge', () => {
  function makeAssistantMsgWithId(
    content: AssistantMessage['message']['content'],
    messageId: string,
  ): AssistantMessage {
    const msg = makeAssistantMsg(content);
    msg.message = { ...msg.message, id: messageId };
    return msg;
  }

  it('merges non-adjacent assistants with same message.id across tool_result user', () => {
    const a1 = makeAssistantMsgWithId(
      [{ type: 'text', text: 'part1' }],
      'msg-A',
    );
    const toolResult = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: 'result',
        is_error: false,
      },
    ]);
    const a2 = makeAssistantMsgWithId(
      [{ type: 'text', text: 'part2' }],
      'msg-A',
    );

    const result = normalizeMessagesForAPI([a1, toolResult, a2]);
    // Should merge a1 and a2 into one assistant message
    const assistants = result.filter(
      (m: { role: string }) => m.role === 'assistant',
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toHaveLength(2);
    expect(textAt(assistants[0])).toBe('part1');
    expect(textAt(assistants[0], 1)).toBe('part2');
  });

  it('does not merge assistants with different message.id', () => {
    const a1 = makeAssistantMsgWithId(
      [{ type: 'text', text: 'first' }],
      'msg-A',
    );
    const toolResult = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: 'result',
        is_error: false,
      },
    ]);
    const a2 = makeAssistantMsgWithId(
      [{ type: 'text', text: 'second' }],
      'msg-B',
    );

    const result = normalizeMessagesForAPI([a1, toolResult, a2]);
    const assistants = result.filter(
      (m: { role: string }) => m.role === 'assistant',
    );
    expect(assistants).toHaveLength(2);
  });
});

describe('normalizeMessagesForAPI — validateImagesForAPI', () => {
  it('replaces an unsupported historical SVG image with text', () => {
    const msg = makeUserMsg([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/svg+xml',
          data: 'PHN2Zz48L3N2Zz4=',
        },
      },
    ]);

    expect(normalizeMessagesForAPI([msg])).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
          },
        ],
      },
    ]);
  });

  it('replaces unsupported SVG images nested in tool results', () => {
    const msg = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-svg',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/svg+xml',
              data: 'PHN2Zz48L3N2Zz4=',
            },
          },
        ],
      },
    ]);

    const result = normalizeMessagesForAPI([msg]);
    expect(byRole(result, 'tool')[0].content).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
      },
    ]);
  });

  it('replaces an unsupported historical SVG URL with text', () => {
    const msg = makeUserMsg([
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://assets.example.test/diagram.svg?revision=1',
        },
      },
    ]);

    expect(normalizeMessagesForAPI([msg])[0].content).toEqual([
      {
        type: 'text',
        text: '[Unsupported image omitted: image/svg+xml. Supported formats are PNG, JPEG, GIF, and WebP.]',
      },
    ]);
  });

  it('throws for oversized base64 images', () => {
    // Create a base64 string larger than 5MB
    const oversizedData = 'A'.repeat(6 * 1024 * 1024);
    const msg = makeUserMsg([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: oversizedData,
        },
      },
    ]);
    expect(() => normalizeMessagesForAPI([msg])).toThrow(
      /Image\(s\) exceed API size limit/,
    );
  });

  it('passes for images within size limit', () => {
    const smallData = 'A'.repeat(100);
    const msg = makeUserMsg([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: smallData },
      },
    ]);
    expect(() => normalizeMessagesForAPI([msg])).not.toThrow();
  });

  it('throws for oversized base64 images nested in tool_result content', () => {
    const oversizedData = 'A'.repeat(6 * 1024 * 1024);
    const msg = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-oversized',
        content: [
          { type: 'text', text: 'Screenshot' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: oversizedData,
            },
          },
        ],
      },
    ]);

    expect(() => normalizeMessagesForAPI([msg])).toThrow(
      /Image\(s\) exceed API size limit.*image\[1\]/,
    );
  });

  it('validates error tool_result images before stripping non-text content', () => {
    const oversizedData = 'A'.repeat(6 * 1024 * 1024);
    const msg = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-error-oversized',
        is_error: true,
        content: [
          { type: 'text', text: 'Error screenshot' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: oversizedData,
            },
          },
        ],
      },
    ]);

    expect(() => normalizeMessagesForAPI([msg])).toThrow(
      /Image\(s\) exceed API size limit.*image\[1\]/,
    );
  });
});

describe('normalizeMessagesForAPI — raw error stripTargets precision', () => {
  it('仅清理精确图片错误对应的 meta 图片消息', () => {
    const userWithImage1 = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/1.png' },
      },
      { type: 'text', text: 'prompt1' },
    ]);
    userWithImage1.isMeta = true;

    const errorMsg = makeUserMsg([
      {
        type: 'text',
        text: '[API Error: Image was too large.]',
      },
    ]);
    errorMsg.isMeta = true;

    const assistant = makeAssistantMsg([
      { type: 'text', text: 'sorry about that' },
    ]);
    const userWithImage2 = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/2.png' },
      },
      { type: 'text', text: 'prompt2' },
    ]);
    userWithImage2.isMeta = true;

    const result = normalizeMessagesForAPI([
      userWithImage1,
      errorMsg,
      assistant,
      userWithImage2,
    ]);

    const users = result.filter((m: { role: string }) => m.role === 'user');
    expect(blocks(users[0]).some((block) => block.type === 'image')).toBe(
      false,
    );
    expect(blocks(users[1]).some((block) => block.type === 'image')).toBe(true);
  });

  it('does not strip across an intervening assistant message', () => {
    const userWithImage = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.png' },
      },
      { type: 'text', text: 'analyze this' },
    ]);
    userWithImage.isMeta = true;
    const assistant = makeAssistantMsg([
      { type: 'text', text: 'partial response' },
    ]);
    const errorMsg = makeUserMsg([
      {
        type: 'text',
        text: '[API Error: Image was too large.]',
      },
    ]);
    errorMsg.isMeta = true;

    const result = normalizeMessagesForAPI([
      userWithImage,
      assistant,
      errorMsg,
    ]);
    const firstUser = result.find((m: { role: string }) => m.role === 'user');
    expect(blocks(firstUser).some((block) => block.type === 'image')).toBe(
      true,
    );
  });

  it('does not strip for unrecognized broad API error text', () => {
    const userWithImage = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.png' },
      },
      { type: 'text', text: 'analyze this' },
    ]);
    userWithImage.isMeta = true;
    const errorMsg = makeUserMsg([
      { type: 'text', text: '[API Error: media too large]' },
    ]);
    errorMsg.isMeta = true;

    const result = normalizeMessagesForAPI([userWithImage, errorMsg]);
    expect(blocks(result[0]).some((block) => block.type === 'image')).toBe(
      true,
    );
  });

  it('does not strip exact media errors from non-meta user messages', () => {
    const userWithImage = makeUserMsg([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.png' },
      },
      { type: 'text', text: 'analyze this' },
    ]);
    const errorMsg = makeUserMsg([
      {
        type: 'text',
        text: '[API Error: Image was too large.]',
      },
    ]);
    errorMsg.isMeta = true;

    const result = normalizeMessagesForAPI([userWithImage, errorMsg]);
    expect(blocks(result[0]).some((block) => block.type === 'image')).toBe(
      true,
    );
  });
});

describe('normalizeMessagesForAPI — sanitizeErrorToolResults', () => {
  it('strips non-text content from is_error tool_results', () => {
    const assistantMsg = makeAssistantMsg([
      { type: 'tool_use', id: 'tu-err', name: 'Read', input: {} },
    ]);
    const userMsg = makeUserMsg([
      {
        type: 'tool_result',
        tool_use_id: 'tu-err',
        is_error: true,
        content: [
          { type: 'text', text: 'Error occurred' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'img' },
          },
        ],
      },
    ]);

    const result = normalizeMessagesForAPI([assistantMsg, userMsg]);
    expect(byRole(result, 'tool')).toEqual([
      {
        role: 'tool',
        toolCallId: 'tu-err',
        isError: true,
        content: [{ type: 'text', text: 'Error occurred' }],
      },
    ]);
  });
});

describe('MCP original names in model history', () => {
  it.each(['mcp__demo__u_611aec98eddc', 'mcp_call'])(
    'omits %s display metadata without changing the model history',
    (name) => {
      const input =
        name === 'mcp_call'
          ? {
              toolName: 'mcp__demo__u_611aec98eddc',
              arguments: { id: 'demo-001' },
            }
          : { id: 'demo-001' };
      const block = {
        type: 'tool_use' as const,
        id: 'mcp-call',
        name,
        input,
      };
      const hostAssistant = makeAssistantMsg([
        {
          ...block,
          mcpInfo: { serverName: '转换服务', toolName: '文档格式转换_查询' },
        },
      ]);
      const history = [
        hostAssistant,
        makeUserMsg([
          {
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'server response',
            is_error: true,
          },
        ]),
      ];
      const saved = JSON.stringify(history);
      const projected = normalizeMessagesForAPI(history);
      expect(byRole(projected, 'assistant')[0].toolCalls).toEqual([
        call(block.id, name, JSON.stringify(input)),
      ]);
      expect(byRole(projected, 'tool')).toEqual([
        {
          role: 'tool',
          toolCallId: block.id,
          content: [{ type: 'text', text: 'server response' }],
          isError: true,
        },
      ]);
      expect(JSON.stringify(projected)).not.toContain('转换服务');
      expect(JSON.stringify(projected)).not.toContain('文档格式转换_查询');
      expect(JSON.stringify(history)).toBe(saved);
      expect(normalizeMessagesForAPI(history)).toEqual(projected);
      expect(projected).toEqual(
        normalizeMessagesForAPI([
          makeAssistantMsg([{ type: 'tool_use', id: block.id, name, input }]),
          history[1],
        ]),
      );
    },
  );
});
