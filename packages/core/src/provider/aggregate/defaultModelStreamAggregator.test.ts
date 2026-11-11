/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DefaultModelStreamAggregator } from './defaultModelStreamAggregator.js';
import type {
  ModelStopReason,
  ModelReasoningMetadata,
  ModelStreamEvent,
} from '../event/modelStreamEvent.js';

const reasoning: ModelReasoningMetadata = Object.freeze({
  id: 'rs-1',
  type: 'reasoning',
  status: 'completed',
  summary: Object.freeze([
    Object.freeze({ type: 'summary_text', text: '摘要' }),
  ]),
});

describe('DefaultModelStreamAggregator 工具参数闭合修复', () => {
  function stoppedTool(raw: string) {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'tool_use', id: 'tool-0', name: 'Read', input: {} },
    });
    aggregator.process({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: raw },
    });
    const completions = aggregator.process({
      type: 'content_block_stop',
      index: 0,
    });
    return { aggregator, completions };
  }

  it.each([
    ['{"path":"a.ts"', { path: 'a.ts' }],
    ['{"items":[{"value":1', { items: [{ value: 1 }] }],
    [
      '{"text":"braces } ] and \\"quote\\""',
      { text: 'braces } ] and "quote"' },
    ],
  ] as const)('只补容器闭合，并等正常 tool_use 终态后交付 %s', (raw, input) => {
    const { aggregator, completions } = stoppedTool(raw);
    expect(completions).toEqual([]);
    const partial = aggregator.getPartialResult();
    expect(partial.openBlocks.get(0)).toEqual({
      type: 'tool_use',
      id: 'tool-0',
      name: 'Read',
      inputJson: raw,
    });
    expect(() => aggregator.getResult()).toThrow('unclosed content blocks');

    const block = { type: 'tool_use', id: 'tool-0', name: 'Read', input };
    expect(
      aggregator.process({
        type: 'message_delta',
        delta: { stopReason: 'tool_use' },
      }),
    ).toEqual([{ type: 'content_block_complete', index: 0, block }]);
    expect(aggregator.getResult().blocks).toEqual([block]);
    expect(partial.openBlocks.get(0)).toMatchObject({ inputJson: raw });
  });

  it.each(['end_turn', 'max_tokens', 'refusal'] as const)(
    '%s 终态保留原始失败参数',
    (stopReason: ModelStopReason) => {
      const raw = '{"path":"a.ts"';
      const { aggregator } = stoppedTool(raw);
      const block = {
        type: 'tool_use',
        id: 'tool-0',
        name: 'Read',
        input: {},
        inputJson: raw,
      };
      expect(
        aggregator.process({ type: 'message_delta', delta: { stopReason } }),
      ).toEqual([{ type: 'content_block_complete', index: 0, block }]);
      expect(aggregator.getResult().blocks).toEqual([block]);
    },
  );

  it.each([
    '{"path":',
    '{"content":"hel',
    '{"value":tru',
    '{"items":[1,2}',
    '{"path":"a.ts",}',
  ])('不填补字段值、引号或删除数据 %s', (raw) => {
    const { aggregator, completions } = stoppedTool(raw);
    const block = {
      type: 'tool_use',
      id: 'tool-0',
      name: 'Read',
      input: {},
      inputJson: raw,
    };
    expect(completions).toEqual([
      { type: 'content_block_complete', index: 0, block },
    ]);
    aggregator.process({
      type: 'message_delta',
      delta: { stopReason: 'tool_use' },
    });
    expect(aggregator.getResult().blocks).toEqual([block]);
  });

  it('修复暂存期间仍可聚合其他合法工具块', () => {
    const { aggregator } = stoppedTool('{"path":"a.ts"');
    aggregator.process({
      type: 'content_block_start',
      index: 1,
      contentBlock: { type: 'tool_use', id: 'tool-1', name: 'List', input: {} },
    });
    expect(
      aggregator.process({ type: 'content_block_stop', index: 1 }),
    ).toEqual([
      {
        type: 'content_block_complete',
        index: 1,
        block: { type: 'tool_use', id: 'tool-1', name: 'List', input: {} },
      },
    ]);
    expect(
      aggregator.process({
        type: 'message_delta',
        delta: { stopReason: 'tool_use' },
      }),
    ).toEqual([
      {
        type: 'content_block_complete',
        index: 0,
        block: {
          type: 'tool_use',
          id: 'tool-0',
          name: 'Read',
          input: { path: 'a.ts' },
        },
      },
    ]);
  });

  it('拒绝暂存关块之后的迟到参数，避免使用过期的修复结果', () => {
    const { aggregator } = stoppedTool('{"path":"a.ts"');
    expect(() =>
      aggregator.process({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ',"extra":1}' },
      }),
    ).toThrow('after content_block_stop');
  });

  it('拒绝复用暂存工具的块索引，避免把旧参数交给新工具', () => {
    const { aggregator } = stoppedTool('{"path":"a.ts"');
    expect(() =>
      aggregator.process({
        type: 'content_block_start',
        index: 0,
        contentBlock: {
          type: 'tool_use',
          id: 'different-tool',
          name: 'Write',
          input: {},
        },
      }),
    ).toThrow('index reused');
  });
});

describe('DefaultModelStreamAggregator 思考回放元数据', () => {
  it('密文块的元数据进入块完成事件与最终结果，不重复存储密文', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'redacted_thinking', data: 'cipher', reasoning },
    });
    const block = { type: 'redacted_thinking', data: 'cipher', reasoning };
    expect(
      aggregator.process({ type: 'content_block_stop', index: 0 }),
    ).toEqual([{ type: 'content_block_complete', index: 0, block }]);
    expect(aggregator.getResult().blocks).toEqual([block]);
    expect(reasoning).not.toHaveProperty('encrypted_content');
  });

  it('关块时到达的元数据与已累积的思考和签名一起保留', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'thinking', thinking: '' },
    });
    aggregator.process({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '思考' },
    });
    aggregator.process({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    });
    const block = {
      type: 'thinking',
      thinking: '思考',
      signature: 'sig',
      reasoning,
    };
    expect(
      aggregator.process({ type: 'content_block_stop', index: 0, reasoning }),
    ).toEqual([{ type: 'content_block_complete', index: 0, block }]);
    expect(aggregator.getResult().blocks).toEqual([block]);
  });

  it('没有元数据的思考块保持原形状，文本块不承载思考元数据', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'thinking', thinking: '' },
    });
    aggregator.process({ type: 'content_block_stop', index: 0 });
    aggregator.process({
      type: 'content_block_start',
      index: 1,
      contentBlock: { type: 'text', text: '' },
    });
    aggregator.process({ type: 'content_block_stop', index: 1, reasoning });
    expect(aggregator.getResult().blocks).toEqual([
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '' },
    ]);
  });
});

describe('DefaultModelStreamAggregator 残缺结果', () => {
  function startText(index: number): ModelStreamEvent {
    return {
      type: 'content_block_start',
      index,
      contentBlock: { type: 'text', text: '' },
    };
  }

  it('快照按原始 index 保留完整块和未闭合块，不提前缓存完成结果', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process(startText(7));
    aggregator.process({
      type: 'content_block_delta',
      index: 7,
      delta: { type: 'text_delta', text: '完成' },
    });
    aggregator.process({ type: 'content_block_stop', index: 7 });
    aggregator.process(startText(2));
    aggregator.process({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: '前半' },
    });
    const first = aggregator.getPartialResult();
    expect(first.openBlocks).toEqual(new Map([[2, { type: 'text', text: '前半' }]]));
    expect(first.openBlocks.has(7)).toBe(false);
    expect(first.blocks[7]).toEqual({ type: 'text', text: '完成' });
    expect(first.blocks).toHaveLength(8);
    expect(Object.keys(first.blocks)).toEqual(['7']);
    expect(() => aggregator.getResult()).toThrow('unclosed content blocks');

    aggregator.process({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: '后半' },
    });
    aggregator.process({ type: 'content_block_stop', index: 2 });
    expect(aggregator.getPartialResult().openBlocks.size).toBe(0);
    expect(aggregator.getResult().blocks[2]).toEqual({
      type: 'text',
      text: '前半后半',
    });
    expect(aggregator.getResult().blocks[7]).toEqual({
      type: 'text',
      text: '完成',
    });
    expect(first.openBlocks.get(2)).toEqual({ type: 'text', text: '前半' });
    expect(Object.keys(first.blocks)).toEqual(['7']);
    const partial = aggregator.getPartialResult();
    expect(partial.blocks).toEqual(aggregator.getResult().blocks);
    expect(partial.blocks).not.toBe(aggregator.getResult().blocks);
    Object.assign(partial.blocks[7], { text: '篡改完整块' });
    expect(aggregator.getPartialResult().blocks[7]).toEqual({ type: 'text', text: '完成' });
    expect(aggregator.getResult().blocks[7]).toEqual({ type: 'text', text: '完成' });
    const complete = aggregator.process({ type: 'message_stop' })[0];
    expect(complete).toEqual({
      type: 'message_complete',
      result: aggregator.getResult(),
    });
    if (complete.type !== 'message_complete')
      throw new Error('缺少消息完成事件');
    expect(complete.result).toBe(aggregator.getResult());
  });

  it('合法和残缺工具 JSON 都投影为残缺块，只有关块后才生成工具输入', () => {
    const aggregator = new DefaultModelStreamAggregator();
    for (const [index, inputJson] of [
      [8, '{"path":"a"}'],
      [3, '{"path":'],
    ] as const) {
      aggregator.process({
        type: 'content_block_start',
        index,
        contentBlock: {
          type: 'tool_use',
          id: `tool-${index}`,
          name: 'Read',
          input: {},
        },
      });
      aggregator.process({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      });
    }
    const openBlocks = aggregator.getPartialResult().openBlocks;
    expect([...openBlocks.keys()]).toEqual([8, 3]);
    expect(openBlocks.get(8)).toEqual({
      type: 'tool_use',
      id: 'tool-8',
      name: 'Read',
      inputJson: '{"path":"a"}',
    });
    expect(openBlocks.get(8)).not.toHaveProperty('input');
    expect(openBlocks.get(3)).toEqual({
      type: 'tool_use',
      id: 'tool-3',
      name: 'Read',
      inputJson: '{"path":',
    });
    for (const block of openBlocks.values())
      expect(block).not.toHaveProperty('kind');
    expect(
      aggregator.process({ type: 'content_block_stop', index: 8 }),
    ).toEqual([
      {
        type: 'content_block_complete',
        index: 8,
        block: {
          type: 'tool_use',
          id: 'tool-8',
          name: 'Read',
          input: { path: 'a' },
        },
      },
    ]);
    const partial = aggregator.getPartialResult();
    expect([...partial.openBlocks.keys()]).toEqual([3]);
    expect(partial.blocks[8]).toEqual({
      type: 'tool_use',
      id: 'tool-8',
      name: 'Read',
      input: { path: 'a' },
    });
    const completeTool = partial.blocks[8];
    if (completeTool.type !== 'tool_use') throw new Error('缺少完整工具块');
    completeTool.input['path'] = '篡改';
    expect(aggregator.getPartialResult().blocks[8]).toMatchObject({ input: { path: 'a' } });
    aggregator.process({ type: 'content_block_stop', index: 3 });
    expect(aggregator.getPartialResult().blocks[3]).toEqual({
      type: 'tool_use',
      id: 'tool-3',
      name: 'Read',
      input: {},
      inputJson: '{"path":',
    });
  });

  it.each([undefined, '', ' \n\t', '{}'])(
    '空工具参数 %j 在完成事件和最终结果中统一为空对象',
    (inputJson) => {
      const aggregator = new DefaultModelStreamAggregator();
      aggregator.process({
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'tool_use', id: 'tool-0', name: 'List', input: {} },
      });
      if (inputJson !== undefined) {
        aggregator.process({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        });
      }
      const block = { type: 'tool_use', id: 'tool-0', name: 'List', input: {} };
      expect(aggregator.process({ type: 'content_block_stop', index: 0 })).toEqual([
        { type: 'content_block_complete', index: 0, block },
      ]);
      expect(aggregator.getResult().blocks).toEqual([block]);
    },
  );

  it.each(['[]', 'null', '42', 'true', '"text"'])(
    '非对象 JSON %s 保留原始参数，不强转为参数对象',
    (inputJson) => {
      const aggregator = new DefaultModelStreamAggregator();
      aggregator.process({
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'tool_use', id: 'tool-0', name: 'Read', input: {} },
      });
      aggregator.process({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      });
      const open = aggregator.getPartialResult().openBlocks.get(0);
      expect(open).toEqual({ type: 'tool_use', id: 'tool-0', name: 'Read', inputJson });
      expect(open).not.toHaveProperty('input');
      const block = { type: 'tool_use', id: 'tool-0', name: 'Read', input: {}, inputJson };
      expect(aggregator.process({ type: 'content_block_stop', index: 0 })).toEqual([
        { type: 'content_block_complete', index: 0, block },
      ]);
      expect(aggregator.getPartialResult().blocks).toEqual([block]);
      expect(aggregator.getResult().blocks).toEqual([block]);
    },
  );

  it('快照独立复制思考、签名、密文和嵌套元数据，不污染缓冲或完成结果', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 1,
      contentBlock: { type: 'thinking', thinking: '', reasoning },
    });
    aggregator.process({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: '思考' },
    });
    aggregator.process({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'sig' },
    });
    aggregator.process({
      type: 'content_block_start',
      index: 4,
      contentBlock: { type: 'redacted_thinking', data: '密文', reasoning },
    });
    const openBlocks = aggregator.getPartialResult().openBlocks;
    expect(openBlocks.get(1)).toMatchObject({
      thinking: '思考',
      signature: 'sig',
      reasoning,
    });
    expect(openBlocks.get(4)).toEqual({
      type: 'redacted_thinking',
      data: '密文',
      reasoning,
    });
    const thinking = openBlocks.get(1);
    if (thinking?.type !== 'thinking') throw new Error('缺少残缺思考块');
    Object.assign(thinking, { thinking: '篡改' });
    Object.assign(thinking.reasoning!.summary![0], { text: '篡改摘要' });
    expect(aggregator.getPartialResult().openBlocks.get(1)).toEqual({
      type: 'thinking',
      thinking: '思考',
      signature: 'sig',
      reasoning,
    });
    const [complete] = aggregator.process({
      type: 'content_block_stop',
      index: 1,
    });
    if (complete.type !== 'content_block_complete')
      throw new Error('缺少完整块');
    Object.assign(complete.block, { thinking: '改完成事件' });
    const closedThinking = aggregator.getPartialResult().blocks[1];
    if (closedThinking.type !== 'thinking') throw new Error('缺少完整思考块');
    Object.assign(closedThinking.reasoning!.summary![0], { text: '篡改完整摘要' });
    expect(aggregator.getPartialResult().blocks[1]).toEqual({
      type: 'thinking',
      thinking: '思考',
      signature: 'sig',
      reasoning,
    });
    expect(() => aggregator.getResult()).toThrow('unclosed content blocks');
    aggregator.process({ type: 'content_block_stop', index: 4 });
    expect(aggregator.getResult().blocks[1]).toMatchObject({
      thinking: '思考',
      signature: 'sig',
    });
  });

  it('完成消息按字段保留 usage 与停止原因', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'message_start',
      message: {
        id: 'm1',
        model: 'model',
        role: 'assistant',
        usage: { inputTokens: 10, cacheReadInputTokens: 3 },
      },
    });
    aggregator.process({
      type: 'message_delta',
      delta: { stopReason: 'refusal' },
      usage: {
        inputTokens: undefined,
        outputTokens: 2,
        cacheReadInputTokens: 0,
      },
    });
    expect(aggregator.getResult()).toMatchObject({
      messageId: 'm1',
      model: 'model',
      stopReason: 'refusal',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
    });
    const partial = aggregator.getPartialResult();
    expect(partial).toEqual({
      messageId: 'm1',
      model: 'model',
      blocks: [],
      openBlocks: new Map(),
      stopReason: 'refusal',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
    });
    Object.assign(partial.usage!, { inputTokens: 999 });
    expect(aggregator.getPartialResult().usage?.inputTokens).toBe(10);
    expect(aggregator.getResult().usage?.inputTokens).toBe(10);
  });

  it('已收到的空工具参数片段原样保留，不污染先前未收到参数的快照', () => {
    const aggregator = new DefaultModelStreamAggregator();
    aggregator.process({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'tool_use', id: 'tool-0', name: 'Read', input: {} },
    });
    const first = aggregator.getPartialResult();
    expect(first.openBlocks.get(0)).not.toHaveProperty('inputJson');
    expect(
      aggregator.process({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '' },
      }),
    ).toEqual([]);
    const block = aggregator.getPartialResult().openBlocks.get(0);
    expect(block).toEqual({
      type: 'tool_use',
      id: 'tool-0',
      name: 'Read',
      inputJson: '',
    });
    expect(block).not.toHaveProperty('input');
    expect(first.openBlocks.get(0)).not.toHaveProperty('inputJson');
  });

  it('刚开始但没有 delta 的四种块都有标准残缺载荷，不生成事件', () => {
    const aggregator = new DefaultModelStreamAggregator();
    const starts: ModelStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'text', text: '' },
      },
      {
        type: 'content_block_start',
        index: 1,
        contentBlock: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_start',
        index: 2,
        contentBlock: { type: 'redacted_thinking', data: '密文' },
      },
      {
        type: 'content_block_start',
        index: 3,
        contentBlock: { type: 'tool_use', id: 'tool-3', name: 'Read', input: {} },
      },
    ];
    for (const event of starts) expect(aggregator.process(event)).toEqual([]);
    expect(aggregator.getPartialResult().openBlocks).toEqual(
      new Map([
        [0, { type: 'text', text: '' }],
        [1, { type: 'thinking', thinking: '' }],
        [2, { type: 'redacted_thinking', data: '密文' }],
        [3, { type: 'tool_use', id: 'tool-3', name: 'Read' }],
      ]),
    );
    expect(aggregator.getPartialResult().openBlocks.get(3)).not.toHaveProperty(
      'inputJson',
    );
    expect(aggregator.getPartialResult()).not.toHaveProperty('type');
  });
});
