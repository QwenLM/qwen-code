/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LeadingThinkingBlockDemoter,
  MAX_LEADING_THINKING_BLOCK_LENGTH,
} from './leading-thinking-block-demoter.js';

const textPart = (text: string) => ({ text });
const thoughtPart = (text: string) => ({ text, thought: true });

describe('LeadingThinkingBlockDemoter', () => {
  it('holds a leading block until a visible answer arrives', () => {
    const demoter = new LeadingThinkingBlockDemoter();

    expect(
      demoter.parse('<thinking>\nsecret reasoning\n</thinking>', false),
    ).toEqual([]);
    expect(demoter.parse('\n\nVisible answer', false)).toEqual([
      thoughtPart('\nsecret reasoning\n'),
      textPart('\n\nVisible answer'),
    ]);
  });

  it('demotes consecutive balanced blocks and stops at the answer', () => {
    const demoter = new LeadingThinkingBlockDemoter();

    expect(
      demoter.parse(
        '<think>first</think>\n<thinking>second</thinking>Answer <think>literal</think>',
        true,
      ),
    ).toEqual([
      thoughtPart('first'),
      thoughtPart('second'),
      textPart('Answer <think>literal</think>'),
    ]);
  });

  it('keeps a nested block whole instead of splitting its inner tags', () => {
    const demoter = new LeadingThinkingBlockDemoter();

    expect(
      demoter.parse(
        '<thinking>outer <think>literal</think></thinking>answer',
        true,
      ),
    ).toEqual([
      thoughtPart('outer <think>literal</think>'),
      textPart('answer'),
    ]);
  });

  it('buffers a block split across calls', () => {
    const demoter = new LeadingThinkingBlockDemoter();

    expect(demoter.parse('<thi', false)).toEqual([]);
    expect(demoter.parse('nk>hidden</thi', false)).toEqual([]);
    expect(demoter.parse('nk> answer', false)).toEqual([
      thoughtPart('hidden'),
      textPart(' answer'),
    ]);
  });

  it('releases a block-only response verbatim at the end', () => {
    const demoter = new LeadingThinkingBlockDemoter();
    const content = '<thinking>\nreasoning\n</thinking>';

    expect(demoter.parse(content, false)).toEqual([]);
    expect(demoter.parse('', true)).toEqual([textPart(content)]);
  });

  it('releases an unclosed block verbatim at the end', () => {
    const demoter = new LeadingThinkingBlockDemoter();
    const content = '<thinking>reasoning';

    expect(demoter.parse(content, false)).toEqual([]);
    expect(demoter.parse('', true)).toEqual([textPart(content)]);
  });

  it.each([
    'Visible answer\n<think>literal</think>',
    '```xml\n<think>literal</think>\n```',
  ])(
    'passes through a response that does not lead with a block: %s',
    (text) => {
      const demoter = new LeadingThinkingBlockDemoter();

      expect(demoter.parse(text, true)).toEqual([textPart(text)]);
    },
  );

  it('releases the buffer once it passes the cap', () => {
    const demoter = new LeadingThinkingBlockDemoter();
    const oversized = `<think>${'x'.repeat(MAX_LEADING_THINKING_BLOCK_LENGTH)}`;

    expect(demoter.parse(oversized, false)).toEqual([textPart(oversized)]);
    expect(demoter.parse('</think>answer', false)).toEqual([
      textPart('</think>answer'),
    ]);
  });

  it('releases buffered text verbatim on request', () => {
    const demoter = new LeadingThinkingBlockDemoter();

    expect(demoter.parse('<think>unfinished', false)).toEqual([]);
    expect(demoter.release()).toBe('<think>unfinished');
    expect(demoter.parse(' more', false)).toEqual([textPart(' more')]);
  });
});
