/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  collectAssistantReport,
  collectSuccessfulNodeReplCalls,
  moduleDirectoryRegistrationRequested,
} from './smoke-transcript.js';

const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: id, is_error: isError, content },
    ],
  },
});

describe('smoke transcript report', () => {
  it('retains the complete report before an extra tool call and short final response', () => {
    const report = 'Order completed. Total: $36.69';
    expect(
      collectAssistantReport([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: report }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'get_goal' }] },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'No active goal' }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done' }] },
        },
        { type: 'result', result: 'Done' },
      ]),
    ).toBe(`${report}\nDone`);
  });

  it('excludes reasoning, code, nested-agent reports, tool output, and malformed events', () => {
    expect(
      collectAssistantReport([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              { type: 'tool_use', input: { code: 'printed text' } },
              { type: 'text', text: 'User report' },
            ],
          },
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'child',
          message: { content: [{ type: 'text', text: 'Nested report' }] },
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'User prompt' }] },
        },
        { type: 'assistant' },
        null,
        'invalid event',
      ]),
    ).toBe('User report');
  });
});

describe('smoke transcript tool uses', () => {
  it('collects REPL cells invoked directly and through the deferred-tool bridge', () => {
    expect(
      collectSuccessfulNodeReplCalls([
        toolUse('a', 'mcp__node-repl__node_repl', { code: 'direct' }),
        toolUse('b', 'tool_call', {
          name: 'mcp__node-repl__node_repl',
          arguments: { code: 'bridged' },
        }),
        toolUse('c', 'tool_call', {
          name: 'mcp__node-repl__node_repl',
          arguments: { code: 'failed' },
        }),
        toolUse('d', 'tool_call', {
          name: 'mcp__node-repl__node_repl_reset',
          arguments: { code: 'other tool' },
        }),
        toolResult('a', 'out-a'),
        toolResult('b', 'out-b'),
        toolResult('c', 'out-c', true),
        toolResult('d', 'out-d'),
      ]),
    ).toEqual([
      { code: 'direct', output: 'out-a' },
      { code: 'bridged', output: 'out-b' },
    ]);
  });

  it.each([
    [
      'a direct call',
      toolUse('t', 'mcp__node-repl__node_repl_add_node_module_dir', {
        path: '/skill/runtime/node_modules',
      }),
      true,
    ],
    [
      'a call through the deferred-tool bridge',
      toolUse('t', 'tool_call', {
        name: 'mcp__node-repl__node_repl_add_node_module_dir',
        arguments: {},
      }),
      true,
    ],
    [
      'an ordinary REPL cell',
      toolUse('t', 'mcp__node-repl__node_repl', { code: '1' }),
      false,
    ],
    [
      'a bridged call to another tool',
      toolUse('t', 'tool_call', { name: 'mcp__node-repl__node_repl_reset' }),
      false,
    ],
  ])(
    'reports module-directory registration for %s',
    (_label, event, expected) => {
      expect(moduleDirectoryRegistrationRequested([event])).toBe(expected);
    },
  );
});
