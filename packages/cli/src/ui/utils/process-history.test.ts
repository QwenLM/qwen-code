/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolCallStatus, type HistoryItem } from '../types.js';
import { projectProcessHistory } from './process-history.js';
import { ToolDisplayNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import type { ShellResultDisplay } from '@qwen-code/qwen-code-core/utils/shell-result.js';

const thought = (id: number): HistoryItem => ({
  id,
  type: 'gemini_thought',
  text: `thought ${id}`,
  durationMs: 2000,
});
const text = (
  id: number,
  type: 'gemini' | 'gemini_content' = 'gemini',
): HistoryItem => ({
  id,
  type,
  text: `answer ${id}`,
});
const tools = (
  id: number,
  name: string = ToolDisplayNames.READ_FILE,
): Extract<HistoryItem, { type: 'tool_group' }> => ({
  id,
  type: 'tool_group',
  tools: [
    {
      callId: String(id),
      name,
      description: `file-${id}`,
      status: ToolCallStatus.Success,
      resultDisplay: `output-${id}`,
      confirmationDetails: undefined,
    },
  ],
});

describe('projectProcessHistory', () => {
  it('combines successive thought/commentary/tool batches and preserves the final text block', () => {
    const input = [
      thought(1),
      text(2),
      text(3, 'gemini_content'),
      tools(4),
      thought(5),
      text(6),
      tools(7, 'Shell'),
      thought(8),
      text(9),
      text(10, 'gemini_content'),
    ];
    const result = projectProcessHistory(input);
    expect(result).toEqual([
      { type: 'process', id: 1, members: input.slice(0, 8) },
      input[8],
      input[9],
    ]);
    expect(result[0].type === 'process' && result[0].members[0]).toBe(input[0]);
    expect(input).toHaveLength(10);
  });

  it('keeps trailing commentary visible until a completed tool establishes its phase', () => {
    const input = [thought(1), tools(2), text(3)];
    expect(projectProcessHistory(input)).toEqual([
      { type: 'process', id: 1, members: input.slice(0, 2) },
      input[2],
    ]);
    const next = tools(4);
    expect(projectProcessHistory([...input, next])).toEqual([
      { type: 'process', id: 1, members: [...input, next] },
    ]);
  });

  it.each([
    ToolCallStatus.Error,
    ToolCallStatus.Canceled,
    ToolCallStatus.Confirming,
    ToolCallStatus.Executing,
    ToolCallStatus.Pending,
  ])('keeps %s tools visible and splits runs', (status) => {
    const boundary = tools(3);
    boundary.tools[0].status = status;
    const input = [thought(1), tools(2), boundary, thought(4), tools(5)];
    expect(projectProcessHistory(input)).toEqual([
      { type: 'process', id: 1, members: input.slice(0, 2) },
      boundary,
      { type: 'process', id: 4, members: input.slice(3) },
    ]);
  });

  it('never crosses user turns, status records, or pending history', () => {
    const boundaries: HistoryItem[] = [
      { id: 3, type: 'user', text: 'next' },
      { id: 3, type: 'warning', text: 'warning' },
      { ...thought(3), isStreaming: true } as HistoryItem,
      tools(-1),
    ];
    for (const boundary of boundaries) {
      const input = [tools(1), text(2), boundary, thought(4), tools(5)];
      expect(projectProcessHistory(input)).toEqual([
        input[0],
        input[1],
        boundary,
        { type: 'process', id: 4, members: input.slice(3) },
      ]);
    }
  });

  it('keeps image-bearing assistant blocks and continuations visible together', () => {
    const input: HistoryItem[] = [
      thought(1),
      text(2),
      {
        ...text(3, 'gemini_content'),
        images: [{ data: 'image', mimeType: 'image/png' }],
      } as HistoryItem,
      tools(4),
    ];
    expect(projectProcessHistory(input)).toEqual(input);
  });

  it('retains specialized results, agents, memory operations, images, and direct shell output', () => {
    const boundaries = [
      tools(2, 'Agent'),
      tools(2, 'Edit'),
      tools(2),
      tools(2),
      tools(2),
    ];
    boundaries[2].tools[0].images = [{ data: 'img', mimeType: 'image/png' }];
    boundaries[3].tools[0].isMemoryOp = 'read';
    boundaries[4].isUserInitiated = true;
    for (const boundary of boundaries) {
      const input = [thought(1), boundary];
      expect(projectProcessHistory(input)).toEqual(input);
    }
  });

  it('keeps a lone tool or thoughts without a tool unchanged', () => {
    for (const input of [[tools(1)], [thought(1), text(2)]]) {
      expect(projectProcessHistory(input)).toEqual(input);
    }
  });

  it('folds completed structured shell results but preserves failures and result notices', () => {
    const display: ShellResultDisplay = {
      type: 'shell_result',
      version: 1,
      text: 'output',
      output: 'output',
      directory: '/tmp',
      exitCode: 0,
      signal: null,
      pid: null,
      error: null,
      outcome: 'completed',
      notices: [],
      truncated: false,
      outputFiles: [],
    };
    const group = tools(2, 'Shell');
    group.tools[0].resultDisplay = display;
    expect(projectProcessHistory([thought(1), group])[0].type).toBe('process');
    const variants: Array<Partial<ShellResultDisplay>> = [
      { outcome: 'failed' },
      { outcome: 'cancelled' },
      { outcome: 'timed_out' },
      { exitCode: 1 },
      { error: 'shell failed' },
      { notices: ['Result was limited'] },
      { truncated: true },
      { outputFiles: ['/tmp/output.txt'] },
    ];
    for (const variant of variants) {
      group.tools[0].resultDisplay = { ...display, ...variant };
      const input = [thought(1), group];
      expect(projectProcessHistory(input)).toEqual(input);
    }
  });
});
