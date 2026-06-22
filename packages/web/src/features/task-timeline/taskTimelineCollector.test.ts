import { describe, expect, it } from 'vitest';
import type {
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  collectTaskTimelineFromTranscript,
  summarizeTaskTimeline,
} from './taskTimelineCollector';

function textBlock(
  overrides: Partial<DaemonTextTranscriptBlock>,
): DaemonTextTranscriptBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `text-${updatedAt}`,
    kind: overrides.kind ?? 'user',
    text: overrides.text ?? 'Build the timeline',
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

function toolBlock(
  overrides: Partial<DaemonToolTranscriptBlock>,
): DaemonToolTranscriptBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `tool-${updatedAt}`,
    kind: 'tool',
    toolCallId: overrides.toolCallId ?? `call-${updatedAt}`,
    title: overrides.title ?? 'Run tool',
    status: overrides.status ?? 'completed',
    preview: overrides.preview ?? { kind: 'generic' },
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

function statusBlock(
  overrides: Partial<DaemonStatusTranscriptBlock>,
): DaemonStatusTranscriptBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `status-${updatedAt}`,
    kind: overrides.kind ?? 'status',
    text: overrides.text ?? 'Status update',
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

type PermissionBlock = Extract<DaemonTranscriptBlock, { kind: 'permission' }>;

function permissionBlock(overrides: Partial<PermissionBlock>): PermissionBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `permission-${updatedAt}`,
    kind: 'permission',
    requestId: overrides.requestId ?? `request-${updatedAt}`,
    title: overrides.title ?? 'Approve tool',
    options: overrides.options ?? [],
    preview: overrides.preview ?? { kind: 'generic' },
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

type PromptCancelledBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'prompt_cancelled' }
>;

function promptCancelledBlock(
  overrides: Partial<PromptCancelledBlock>,
): PromptCancelledBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `cancelled-${updatedAt}`,
    kind: 'prompt_cancelled',
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

describe('collectTaskTimelineFromTranscript', () => {
  it('collects prompt, tool, and error blocks', () => {
    const items = collectTaskTimelineFromTranscript([
      textBlock({
        id: 'prompt',
        text: 'Run tests\nthen report',
        updatedAt: 100,
      }),
      toolBlock({
        id: 'tool',
        title: 'Run tests',
        toolName: 'Bash',
        status: 'running',
        updatedAt: 200,
      }),
      statusBlock({
        id: 'error',
        kind: 'error',
        text: 'Build failed',
        updatedAt: 300,
      }),
    ]);

    expect(
      items.map((item) => ({
        kind: item.kind,
        status: item.status,
        title: item.title,
      })),
    ).toEqual([
      { kind: 'prompt', status: 'info', title: 'Run tests then report' },
      { kind: 'tool', status: 'running', title: 'Bash' },
      { kind: 'status', status: 'failed', title: 'Build failed' },
    ]);
  });

  it('infers todo state transitions without duplicate snapshots', () => {
    const blocks = [
      toolBlock({
        id: 'todo-pending',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [{ id: 'one', content: 'Design timeline', status: 'pending' }],
        },
        updatedAt: 100,
      }),
      toolBlock({
        id: 'todo-duplicate',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [{ id: 'one', content: 'Design timeline', status: 'pending' }],
        },
        updatedAt: 110,
      }),
      toolBlock({
        id: 'todo-running',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            { id: 'one', content: 'Design timeline', status: 'in_progress' },
          ],
        },
        updatedAt: 120,
      }),
      toolBlock({
        id: 'todo-completed',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            { id: 'one', content: 'Design timeline', status: 'completed' },
          ],
        },
        updatedAt: 130,
      }),
    ];

    const todoItems = collectTaskTimelineFromTranscript(blocks).filter(
      (item) => item.kind === 'todo',
    );

    expect(todoItems.map((item) => item.status)).toEqual([
      'pending',
      'running',
      'completed',
    ]);
    expect(todoItems.map((item) => item.timestamp)).toEqual([100, 120, 130]);
  });

  it('maps permission and prompt cancellation states', () => {
    const items = collectTaskTimelineFromTranscript([
      permissionBlock({ id: 'permission-open', updatedAt: 100 }),
      permissionBlock({
        id: 'permission-closed',
        resolved: 'allow',
        updatedAt: 200,
      }),
      promptCancelledBlock({
        reason: 'User stopped generation',
        updatedAt: 300,
      }),
    ]);

    expect(items.map((item) => item.status)).toEqual([
      'blocked',
      'completed',
      'cancelled',
    ]);
  });

  it('keeps transcript order and caps to the most recent items', () => {
    const blocks = Array.from({ length: 105 }, (_, index) =>
      textBlock({
        id: `prompt-${index}`,
        text: `Prompt ${index}`,
        updatedAt: index,
      }),
    );

    const items = collectTaskTimelineFromTranscript(blocks);

    expect(items).toHaveLength(100);
    expect(items[0]?.title).toBe('Prompt 5');
    expect(items.at(-1)?.title).toBe('Prompt 104');
  });

  it('uses server timestamp before local timestamp fallbacks', () => {
    const items = collectTaskTimelineFromTranscript([
      textBlock({
        text: 'Timestamp check',
        serverTimestamp: 42,
        clientReceivedAt: 100,
        createdAt: 200,
        updatedAt: 300,
      }),
    ]);

    expect(items[0]?.timestamp).toBe(42);
  });

  it('summarizes active and terminal states', () => {
    const summary = summarizeTaskTimeline([
      {
        id: 'one',
        kind: 'tool',
        status: 'running',
        title: 'Run',
        timestamp: 1,
      },
      {
        id: 'two',
        kind: 'permission',
        status: 'blocked',
        title: 'Approve',
        timestamp: 2,
      },
      {
        id: 'three',
        kind: 'tool',
        status: 'completed',
        title: 'Done',
        timestamp: 3,
      },
      {
        id: 'four',
        kind: 'status',
        status: 'failed',
        title: 'Failed',
        timestamp: 4,
      },
    ]);

    expect(summary).toEqual({
      total: 4,
      running: 1,
      completed: 1,
      failed: 1,
      blocked: 1,
      activeTitle: 'Approve',
    });
  });
});
