/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ASK_USER_TOOL_NAME, cloneUsage, type Message } from '@qwen-code/core';
import {
  collectSubagentToolResults,
  projectSubagentToolActivity,
  projectSubagentToolCalls,
  projectSubagentRecentActivity,
} from './subagentTraceProjection.js';

const usage = { ...cloneUsage(), input_tokens: 1, output_tokens: 1 };

describe('subagentTraceProjection', () => {
  it('deduplicates legacy CodeMode polls without hiding status changes or changing history', () => {
    const messages: Array<Extract<Message, { type: 'user' }>> = [
      'pending',
      'pending',
      'completed',
      'completed',
    ].map((status, index) => ({
      type: 'user',
      uuid: String(index),
      timestamp: '2026-10-15T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: String(index), content: '' },
        ],
      },
      toolUseResult: {
        type: 'code_mode',
        cellId: 'cell',
        calls: [
          {
            callId: 'child',
            name: 'Read',
            status,
            args: { file_path: 'a.ts' },
          },
        ],
      },
    }));
    const original = JSON.stringify(messages);
    const results = [...collectSubagentToolResults(messages).values()];
    expect(
      results.map(
        (result) => (result.toolUseResult as { calls: unknown[] }).calls.length,
      ),
    ).toEqual([1, 0, 1, 0]);
    expect(results[3].toolUseResult).toMatchObject({ totalCalls: 1 });
    expect(JSON.stringify(messages)).toBe(original);
    expect(
      collectSubagentToolResults(messages.slice(2)).get('2')?.toolUseResult,
    ).toMatchObject({ calls: [{ status: 'completed' }] });
    const delta = structuredClone(messages[3]);
    delta.toolUseResult = {
      ...(delta.toolUseResult as object),
      callsMode: 'delta',
    };
    expect(
      collectSubagentToolResults([...messages.slice(0, 3), delta]).get('3')
        ?.toolUseResult,
    ).toMatchObject({ calls: [{ status: 'completed' }] });
    const other = structuredClone(messages[3]);
    other.toolUseResult = {
      ...(other.toolUseResult as object),
      cellId: 'other',
    };
    expect(
      collectSubagentToolResults([...messages.slice(0, 3), other]).get('3')
        ?.toolUseResult,
    ).toMatchObject({ calls: [{ status: 'completed' }] });
  });
  it('matches parallel tool results by tool_use_id and preserves structured results', () => {
    const messages: Message[] = [
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: new Date().toISOString(),
        message: {
          id: 'resp-1',
                    type: 'message',
                    role: 'assistant',
                    stop_sequence: null,
                    container: null,
                    context_management: null,

          model: 'test-model',
          stop_reason: 'tool_use',

          usage,
          content: [
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: { file_path: 'package.json' },
            },
            {
              type: 'tool_use',
              id: 'tool-grep',
              name: 'Grep',
              input: { pattern: 'render', path: 'src' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: new Date().toISOString(),
        toolUseResult: [
          { matches: ['src/render.ts'] },
          { summary: 'read package.json' },
        ],
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-grep',
              content: 'grep result',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-read',
              content: 'read result',
              is_error: false,
            },
          ],
        },
      },
    ];

    const results = collectSubagentToolResults(messages);
    expect(results.get('tool-grep')?.toolUseResult).toEqual({
      matches: ['src/render.ts'],
    });
    expect(results.get('tool-read')?.toolUseResult).toEqual({
      summary: 'read package.json',
    });

    expect(projectSubagentRecentActivity(messages)).toMatchObject([
      {
        id: 'tool-read',
        displayName: 'Read',
        description: 'package.json',
        status: 'completed',
      },
      {
        id: 'tool-grep',
        displayName: 'Grep',
        description: "'render' within src",
        status: 'completed',
      },
    ]);
  });

  it('renders absolute Read paths relative to the provided target directory', () => {
    const assistantMessage: Extract<Message, { type: 'assistant' }> = {
      type: 'assistant',
      uuid: 'assistant-read',
      timestamp: new Date().toISOString(),
      message: {
        id: 'resp-read',
                type: 'message',
                role: 'assistant',
                stop_sequence: null,
                container: null,
                context_management: null,

        model: 'test-model',
        stop_reason: 'tool_use',

        usage,
        content: [
          {
            type: 'tool_use',
            id: 'tool-read',
            name: 'Read',
            input: {
              file_path: '/repo/src/file.ts',
              offset: 4,
              limit: 2,
            },
          },
        ],
      },
    };

    expect(
      projectSubagentRecentActivity([assistantMessage], {
        targetDir: '/repo',
      }),
    ).toMatchObject([
      {
        id: 'tool-read',
        displayName: 'Read',
        description: 'src/file.ts · lines 5-6',
        args: JSON.stringify({
          description: 'src/file.ts · lines 5-6',
        }),
        status: 'running',
      },
    ]);

    expect(
      projectSubagentToolCalls(assistantMessage, new Map(), {
        targetDir: '/repo',
      })[0],
    ).toMatchObject({
      callId: 'tool-read',
      name: 'Read',
      description: 'src/file.ts · lines 5-6',
    });
  });

  it('preserves complete tool inputs and results for the lazy expanded view', () => {
    const glob = projectSubagentToolActivity({
      id: 'glob-1',
      name: 'Glob',
      input: { pattern: '**/*.md' },
      toolResult: {
        content: '',
        isError: false,
        toolUseResult: {
          durationMs: 10,
          numFiles: 10,
          filenames: Array.from({ length: 10 }, (_, index) => `${index}.md`),
          truncated: false,
        },
      },
    });
    const grep = projectSubagentToolActivity({
      id: 'grep-1',
      name: 'Grep',
      input: { pattern: 'needle' },
      toolResult: {
        content: '',
        isError: false,
        toolUseResult: {
          mode: 'content',
          numFiles: 2,
          filenames: ['one.ts', 'two.ts'],
          content: 'large grep payload'.repeat(10_000),
          numMatches: 12,
        },
      },
    });

    expect(glob.toolInput).toEqual({ pattern: '**/*.md' });
    expect(glob.toolResult?.toolUseResult).toMatchObject({ numFiles: 10 });
    expect(grep.toolInput).toEqual({ pattern: 'needle' });
    expect(grep.toolResult?.toolUseResult).toMatchObject({
      numMatches: 12,
    });
    expect(JSON.stringify(grep.toolResult)).toContain('large grep payload');
  });

  it('keeps compact boundaries in chronological expanded history', () => {
    const messages: Message[] = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
        timestamp: new Date().toISOString(),
        content: 'Conversation compacted',
        level: 'info',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 100_000,
          postTokens: 20_000,
        },
      },
    ];

    expect(projectSubagentRecentActivity(messages)).toEqual([
      {
        id: 'compact-1',
        type: 'compact',
        content: 'Conversation compacted',
        status: 'completed',
        preTokens: 100_000,
        postTokens: 20_000,
      },
    ]);
  });

  it('projects AskUserQuestion structured answers for the shared tool renderer', () => {
    const assistantMessage: Extract<Message, { type: 'assistant' }> = {
      type: 'assistant',
      uuid: 'assistant-ask',
      timestamp: new Date().toISOString(),
      message: {
        id: 'resp-ask',
                type: 'message',
                role: 'assistant',
                stop_sequence: null,
                container: null,
                context_management: null,

        model: 'test-model',
        stop_reason: 'tool_use',

        usage,
        content: [
          {
            type: 'tool_use',
            id: 'tool-ask',
            name: ASK_USER_TOOL_NAME,
            input: {
              questions: [
                {
                  question: 'Python 项目放在哪里?',
                  header: '项目位置',
                  options: [
                    {
                      label: '当前仓库根目录下新建 sample-py/',
                      description: 'Use current repository',
                    },
                    {
                      label: '其他位置',
                      description: 'Choose another location',
                    },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      },
    };
    const messages: Message[] = [
      assistantMessage,
      {
        type: 'user',
        uuid: 'user-ask',
        timestamp: new Date().toISOString(),
        toolUseResult: {
          questions: [
            {
              question: 'Python 项目放在哪里?',
              header: '项目位置',
            },
          ],
          answers: {
            'Python 项目放在哪里?': '当前仓库根目录下新建 sample-py/',
          },
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-ask',
              content:
                'User has answered your questions: "Python 项目放在哪里?"="当前仓库根目录下新建 sample-py/".',
              is_error: false,
            },
          ],
        },
      },
    ];

    const toolCalls = projectSubagentToolCalls(
      assistantMessage,
      collectSubagentToolResults(messages),
    );

    expect(toolCalls[0]).toMatchObject({
      callId: 'tool-ask',
      name: 'AskUserQuestion',
      description: 'Asking user: Python 项目放在哪里?',
      resultDisplay:
        '**User answered:**\n  Q: Python 项目放在哪里?\n  项目位置 → 当前仓库根目录下新建 sample-py/',
    });
  });
});
