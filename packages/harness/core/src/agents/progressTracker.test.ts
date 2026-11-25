/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ProgressTracker } from './progressTracker.js';
import type { QueryEvent } from '../core/query-event.js';

describe('ProgressTracker', () => {
  it('updates tool activity status from tool_result without storing result summary', () => {
    const publishActivity = vi.fn();
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
      publishActivity,
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'missing.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content:
              'Error: File does not exist. Note: your current working directory is /tmp/project.',
            is_error: true,
            toolUseResult:
              'Error: File does not exist. Note: your current working directory is /tmp/project.',
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      type: 'tool_call',
      content: 'Read',
      status: 'error',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
    expect(publishActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'tool-1',
        status: 'error',
      }),
    );
  });

  it('keeps pending tool display status when completion arrives before tool activity', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.updateToolDisplay({
      toolUseId: 'tool-1',
      status: 'error',
      displayName: 'Read',
      description: 'missing.txt',
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'missing.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content:
              'Error: File does not exist. Note: your current working directory is /tmp/project.',
            is_error: true,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      status: 'error',
      displayName: 'Read',
      description: 'missing.txt',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
  });

  it('does not store fallback output from tool_result content', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'one.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: '1\tfile contents',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      status: 'completed',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
  });

  it('updates tool activity description from UI display metadata', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { description: 'First task', status: 'pending' },
                { description: 'Second task', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.updateToolDisplay({
      toolUseId: 'tool-1',
      status: 'completed',
      displayName: 'TodoWrite',
      description: 'Set 2 todo(s)',
    });

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      status: 'completed',
      displayName: 'TodoWrite',
      description: 'Set 2 todo(s)',
    });
  });

  it('projects tool display metadata when tool_use activity is created', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'package.json', offset: 10, limit: 5 },
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      type: 'tool_call',
      content: 'Read',
      displayName: 'Read',
      description: 'package.json · lines 10-14',
      args: JSON.stringify({ description: 'package.json · lines 10-14' }),
      status: 'running',
    });
  });

  it('renders absolute file path arguments relative to the configured target directory', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      targetDir: '/repo',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: {
              file_path: '/repo/src/package.json',
              offset: 10,
              limit: 5,
            },
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-1',
      type: 'tool_call',
      content: 'Read',
      displayName: 'Read',
      description: 'src/package.json · lines 10-14',
      args: JSON.stringify({
        description: 'src/package.json · lines 10-14',
      }),
      status: 'running',
    });
  });

  it('updates tool activity from structured tool_result without storing result summary', () => {
    const publishActivity = vi.fn();
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
      publishActivity,
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'package.json' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'full result line 1\nfull result line 2',
            is_error: false,
            toolUseResult: {
              summary: 'Read package.json',
              payload: 'full result line 1\nfull result line 2',
            },
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      type: 'tool_call',
      content: 'Read',
      status: 'completed',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
    expect(publishActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'completed',
      }),
    );
  });

  it('matches tool results by tool_use_id for parallel tool calls', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-a',
            name: 'Read',
            input: { file_path: 'a.txt' },
          },
          {
            type: 'tool_use',
            id: 'tool-b',
            name: 'Read',
            input: { file_path: 'b.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-a',
            content: 'A result',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-b',
            content: 'B result',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity).toMatchObject([
      {
        id: 'tool-a',
        status: 'completed',
      },
      {
        id: 'tool-b',
        status: 'completed',
      },
    ]);
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
    expect(tracker.recentActivity[1]).not.toHaveProperty('result');
  });

  it('does not retain per-result structured data for parallel tool calls', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-a',
            name: 'WebFetch',
            input: { url: 'https://example.com/a', prompt: 'summarize' },
          },
          {
            type: 'tool_use',
            id: 'tool-b',
            name: 'WebFetch',
            input: { url: 'https://example.com/b', prompt: 'summarize' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      toolUseResult: [
        { summary: 'A summary', payload: 'A payload' },
        { summary: 'B summary', payload: 'B payload' },
      ],
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-a',
            content: 'A result',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-b',
            content: 'B result',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0].toolResult).toBeUndefined();
    expect(tracker.recentActivity[1].toolResult).toBeUndefined();
    expect(tracker.recentActivity.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('does not retain a large structured result in the parent preview', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-large-read',
            name: 'Read',
            input: { file_path: 'large.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    const marker = 'RAW_FILE_PAYLOAD_MUST_NOT_BE_RETAINED';
    tracker.handleQueryEvent({
      type: 'user',
      toolUseResult: {
        type: 'text',
        file: {
          content: `${marker}${'x'.repeat(1024 * 1024)}`,
          startLine: 1,
          numLines: 10_000,
          totalLines: 10_000,
        },
      },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-large-read',
            content: marker,
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    const serialized = JSON.stringify(tracker.makeProgress('completed'));
    expect(tracker.recentActivity[0].toolResult).toBeUndefined();
    expect(serialized).not.toContain(marker);
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('does not retain Glob and Grep result payloads in the parent preview', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'glob-1', name: 'Glob', input: {} },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: {} },
        ],
      },
    } as unknown as QueryEvent);
    tracker.handleQueryEvent({
      type: 'user',
      toolUseResult: [
        {
          durationMs: 10,
          numFiles: 10,
          filenames: Array.from({ length: 10 }, (_, index) => `${index}.md`),
          truncated: false,
        },
        {
          mode: 'content',
          numFiles: 2,
          filenames: ['one.ts', 'two.ts'],
          content: 'large grep payload'.repeat(10_000),
          numMatches: 12,
        },
      ],
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'glob-1',
            content: 'glob payload',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'grep-1',
            content: 'grep payload',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity.map((item) => item.toolResult)).toEqual([
      undefined,
      undefined,
    ]);
    expect(tracker.recentActivity.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(JSON.stringify(tracker.makeProgress('completed'))).not.toContain(
      'large grep payload',
    );
  });

  it('keeps a bounded activity preview and an independent tool count', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      agentId: 'agent-1',
      updateOutput: vi.fn(),
    });

    for (let index = 0; index < 8; index++) {
      tracker.handleQueryEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `tool-${index}`,
              name: 'Read',
              input: { file_path: `${index}.txt` },
            },
          ],
        },
      } as unknown as QueryEvent);
    }

    expect(tracker.recentActivity.map((item) => item.id)).toEqual([
      'tool-3',
      'tool-4',
      'tool-5',
      'tool-6',
      'tool-7',
    ]);
    expect(tracker.toolUseCount).toBe(8);
    expect(tracker.makeProgress('running')).toMatchObject({
      agentId: 'agent-1',
      toolUseCount: 8,
    });
    expect(
      tracker.makeProgress('completed').recentActivity.map((item) => item.id),
    ).toEqual([
      'tool-3',
      'tool-4',
      'tool-5',
      'tool-6',
      'tool-7',
    ]);
  });

  it('does not fall back to running tool when tool_use_id is unknown', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-b',
            name: 'Read',
            input: { file_path: 'b.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'missing-tool',
            content: 'stale result',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-b',
      status: 'running',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
  });

  it('does not fall back to running tool when tool_use_id is missing', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-b',
            name: 'Read',
            input: { file_path: 'b.txt' },
          },
        ],
      },
    } as unknown as QueryEvent);

    tracker.handleQueryEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'unkeyed result',
            is_error: false,
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0]).toMatchObject({
      id: 'tool-b',
      status: 'running',
    });
    expect(tracker.recentActivity[0]).not.toHaveProperty('result');
  });

  it('stores projected tool args in activity state', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Write',
            input: {
              file_path: '/tmp/large.txt',
              content: 'x'.repeat(1000),
            },
          },
        ],
      },
    } as unknown as QueryEvent);

    expect(tracker.recentActivity[0].args).toBe(
      JSON.stringify({ description: '/tmp/large.txt' }),
    );
    expect(tracker.recentActivity[0].args).not.toContain('x'.repeat(100));
  });

  it('truncates generic tool args before storing activity state', () => {
    const tracker = new ProgressTracker({
      agentName: 'research',
      updateOutput: vi.fn(),
    });

    tracker.handleQueryEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'McpTool',
            input: {
              payload: 'x'.repeat(1000),
              options: {
                nested: 'y'.repeat(1000),
              },
            },
          },
        ],
      },
    } as unknown as QueryEvent);

    const description = tracker.recentActivity[0].description ?? '';
    const args = tracker.recentActivity[0].args ?? '';
    expect(description.length).toBeLessThanOrEqual(123);
    expect(args.length).toBeLessThan(160);
    expect(description).not.toContain('x'.repeat(200));
    expect(JSON.parse(args)).toHaveProperty('description');
  });
});
