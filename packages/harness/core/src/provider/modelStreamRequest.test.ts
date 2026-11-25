/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  ModelRedactedThinkingBlock,
  ModelTextBlock,
  ModelThinkingBlock,
  ModelToolUseBlock,
} from './event/modelCompleteEvent.js';
import type {
  ModelImageBlock,
  ModelStreamAssistantContent,
  ModelStreamRequest,
  ModelStreamSystemContent,
  ModelStreamToolResultContent,
  ModelStreamUserContent,
} from './modelStreamRequest.js';

const textBlocks: readonly ModelTextBlock[] = Object.freeze([
  { type: 'text', text: 'first' },
  { type: 'text', text: 'second' },
]);

// 各协议的请求映射见 transport/impl/*-factory 旁的工厂单测。
describe('ModelStreamRequest 内容契约', () => {
  it('四种 content 都兼容字符串和只读文本块数组', () => {
    expectTypeOf<string>().toExtend<ModelStreamSystemContent>();
    expectTypeOf<string>().toExtend<ModelStreamUserContent>();
    expectTypeOf<string>().toExtend<ModelStreamAssistantContent>();
    expectTypeOf<string>().toExtend<ModelStreamToolResultContent>();
    expectTypeOf(textBlocks).toExtend<ModelStreamSystemContent>();
    expectTypeOf(textBlocks).toExtend<ModelStreamUserContent>();
    expectTypeOf(textBlocks).toExtend<ModelStreamAssistantContent>();
    expectTypeOf(textBlocks).toExtend<ModelStreamToolResultContent>();
    expectTypeOf<Extract<ModelStreamRequest['prompt']['messages'][number], { role: 'system' }>['content']>().toEqualTypeOf<ModelStreamSystemContent>();
  });

  it('user/tool 允许图片，system/assistant 不允许图片', () => {
    expectTypeOf<
      readonly ModelImageBlock[]
    >().toExtend<ModelStreamUserContent>();
    expectTypeOf<
      readonly ModelImageBlock[]
    >().toExtend<ModelStreamToolResultContent>();
    expectTypeOf<
      readonly ModelImageBlock[]
    >().not.toExtend<ModelStreamSystemContent>();
    expectTypeOf<
      readonly ModelImageBlock[]
    >().not.toExtend<ModelStreamAssistantContent>();
    expectTypeOf<ModelStreamUserContent>().toEqualTypeOf<ModelStreamToolResultContent>();
  });

  it('只有 assistant 允许思考块，工具调用不进入 content', () => {
    type ReasoningContent = ReadonlyArray<
      ModelThinkingBlock | ModelRedactedThinkingBlock
    >;
    expectTypeOf<ReasoningContent>().toExtend<ModelStreamAssistantContent>();
    expectTypeOf<ReasoningContent>().not.toExtend<ModelStreamSystemContent>();
    expectTypeOf<ReasoningContent>().not.toExtend<ModelStreamUserContent>();
    expectTypeOf<ReasoningContent>().not.toExtend<ModelStreamToolResultContent>();
    expectTypeOf<
      readonly ModelToolUseBlock[]
    >().not.toExtend<ModelStreamAssistantContent>();
  });
});
