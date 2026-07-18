import { describe, expect, it } from 'vitest';
import type { ObservedChannelContactGraph } from '@qwen-code/channel-base';
import { resolveObservedScheduledTaskChannelTarget } from './scheduled-task-channel-admission.js';

const graph: ObservedChannelContactGraph = {
  users: [
    {
      channelName: 'dingtalk',
      id: 'user-1',
      label: 'Ada',
      lastObservedAt: '2026-07-18T00:00:00.000Z',
    },
  ],
  groups: [
    {
      channelName: 'dingtalk',
      id: 'group-1',
      label: 'Inspection group',
      lastObservedAt: '2026-07-18T00:00:00.000Z',
      users: [],
      topics: [
        {
          id: 'topic-1',
          label: 'Daily checks',
          lastObservedAt: '2026-07-18T00:00:00.000Z',
          users: [],
        },
      ],
    },
  ],
};

describe('resolveObservedScheduledTaskChannelTarget', () => {
  it('canonicalizes an observed group and topic', () => {
    expect(
      resolveObservedScheduledTaskChannelTarget(graph, {
        channelName: 'dingtalk',
        chatId: 'group-1',
        threadId: 'topic-1',
      }),
    ).toEqual({
      channelName: 'dingtalk',
      chatId: 'group-1',
      threadId: 'topic-1',
      isGroup: true,
    });
  });

  it('canonicalizes an observed direct-message user', () => {
    expect(
      resolveObservedScheduledTaskChannelTarget(graph, {
        channelName: 'dingtalk',
        chatId: 'user-1',
      }),
    ).toEqual({
      channelName: 'dingtalk',
      chatId: 'user-1',
      isGroup: false,
    });
  });

  it('rejects unknown, mismatched, and ambiguous targets', () => {
    expect(
      resolveObservedScheduledTaskChannelTarget(graph, {
        channelName: 'dingtalk',
        chatId: 'missing',
      }),
    ).toBeNull();
    expect(
      resolveObservedScheduledTaskChannelTarget(graph, {
        channelName: 'dingtalk',
        chatId: 'group-1',
        isGroup: false,
      }),
    ).toBeNull();

    const ambiguous: ObservedChannelContactGraph = {
      users: [
        {
          channelName: 'dingtalk',
          id: 'same-id',
          label: 'User',
          lastObservedAt: '2026-07-18T00:00:00.000Z',
        },
      ],
      groups: [
        {
          channelName: 'dingtalk',
          id: 'same-id',
          label: 'Group',
          lastObservedAt: '2026-07-18T00:00:00.000Z',
          users: [],
          topics: [],
        },
      ],
    };
    expect(
      resolveObservedScheduledTaskChannelTarget(ambiguous, {
        channelName: 'dingtalk',
        chatId: 'same-id',
      }),
    ).toBeNull();
  });
});
