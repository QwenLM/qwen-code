import { describe, expect, it } from 'vitest';
import type { DaemonObservedChannelContacts } from '@qwen-code/webui/daemon-react-sdk';
import {
  deliveryTargetKey,
  flattenScheduledTaskDeliveryTargets,
  resolveScheduledTaskDeliveryInput,
} from './scheduledTaskDeliveryTargets';

const graph: DaemonObservedChannelContacts = {
  users: [
    {
      channelName: 'dingtalk',
      id: 'user-1',
      label: 'Alice',
      chatId: 'staff-1',
      lastObservedAt: '2026-07-18T10:00:00.000Z',
    },
    {
      channelName: 'dingtalk',
      id: 'user-without-chat',
      label: 'No route',
      lastObservedAt: '2026-07-18T10:00:00.000Z',
    },
  ],
  groups: [
    {
      channelName: 'dingtalk',
      id: 'group-1',
      label: 'Release group',
      lastObservedAt: '2026-07-18T10:00:00.000Z',
      users: [],
      topics: [
        {
          id: 'topic-1',
          label: 'Deployments',
          lastObservedAt: '2026-07-18T10:00:00.000Z',
          users: [],
        },
      ],
    },
  ],
};

describe('scheduled task delivery targets', () => {
  it('flattens routable direct, group, and topic observations', () => {
    const options = flattenScheduledTaskDeliveryTargets(graph);

    expect(options.map((option) => option.kind)).toEqual([
      'direct',
      'group',
      'topic',
    ]);
    expect(options[0]!.target).toEqual({
      channelName: 'dingtalk',
      chatId: 'staff-1',
      isGroup: false,
    });
    expect(options[1]!.target).toEqual({
      channelName: 'dingtalk',
      chatId: 'group-1',
      isGroup: true,
    });
    expect(options[2]!.target).toEqual({
      channelName: 'dingtalk',
      chatId: 'group-1',
      threadId: 'topic-1',
      isGroup: true,
    });
  });

  it('resolves a formatted selection or one unambiguous exact id', () => {
    const options = flattenScheduledTaskDeliveryTargets(graph);

    expect(resolveScheduledTaskDeliveryInput('topic-1', options)).toBe(
      options[2],
    );
    expect(
      resolveScheduledTaskDeliveryInput(options[1]!.inputValue, options),
    ).toBe(options[1]);
    expect(resolveScheduledTaskDeliveryInput('unknown', options)).toBeNull();
  });

  it('rejects an exact id shared by more than one destination', () => {
    const options = flattenScheduledTaskDeliveryTargets({
      users: [
        {
          channelName: 'dingtalk',
          id: 'user-1',
          label: 'Alice',
          chatId: 'shared-id',
          lastObservedAt: '2026-07-18T10:00:00.000Z',
        },
      ],
      groups: [
        {
          channelName: 'dingtalk',
          id: 'shared-id',
          label: 'Shared group',
          lastObservedAt: '2026-07-18T10:00:00.000Z',
          users: [],
          topics: [],
        },
      ],
    });

    expect(resolveScheduledTaskDeliveryInput('shared-id', options)).toBeNull();
  });

  it('uses collision-safe target keys for opaque ids', () => {
    expect(
      deliveryTargetKey({
        channelName: 'a:b',
        chatId: 'c',
        threadId: 'd',
        isGroup: true,
      }),
    ).not.toBe(
      deliveryTargetKey({
        channelName: 'a',
        chatId: 'b:c',
        threadId: 'd',
        isGroup: true,
      }),
    );
  });
});
