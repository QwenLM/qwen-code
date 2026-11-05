/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type ChannelEventsMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const CHANNEL_EVENTS_MESSAGES_EN: Record<string, ChannelEventsMessage> =
  {
    'channelEvents.title': 'Channel events',
    'channelEvents.subtitle':
      'What each Channel did: what it accepted or skipped, what it published, how its tasks moved, and how its polls went.',
    'channelEvents.refresh': 'Refresh',
    'channelEvents.filterChannel': 'Channel',
    'channelEvents.allChannels': 'All channels',
    'channelEvents.filterType': 'Type',
    'channelEvents.typeAll': 'All',
    'channelEvents.type.inbound': 'Inbound',
    'channelEvents.type.outbound': 'Outbound',
    'channelEvents.type.task': 'Task',
    'channelEvents.type.poll': 'Poll',
    'channelEvents.outcome.accepted': 'Accepted',
    'channelEvents.outcome.skipped': 'Skipped',
    'channelEvents.outcome.posted': 'Posted',
    'channelEvents.outcome.suppressed': 'Suppressed',
    'channelEvents.outcome.posting': 'Posting',
    'channelEvents.outcome.failed': 'Failed',
    'channelEvents.outcome.ok': 'OK',
    'channelEvents.outcome.running': 'Running',
    'channelEvents.outcome.reply_pending': 'Reply pending',
    'channelEvents.outcome.cancelled': 'Cancelled',
    'channelEvents.emptyTitle': 'No events yet',
    'channelEvents.emptyDescription':
      'Events appear as soon as a Channel polls, receives a message, or publishes a reply.',
    'channelEvents.errorTitle': 'Could not load Channel events',
    'channelEvents.unavailable':
      'Channel events need Channel management in this workspace.',
    'channelEvents.truncated': 'Older events are not shown.',
    'channelEvents.loading': 'Loading events…',
    'channelEvents.duration': (v) => `${v?.ms ?? 0} ms`,
    'channelEvents.notifications': (v) =>
      `${v?.count ?? 0} notification${v?.count === 1 ? '' : 's'}`,
    'channelEvents.moreFiltered': (v) =>
      `${v?.count ?? 0} more filtered this poll`,
    'channelEvents.openTarget': (v) => `Open ${v?.target ?? ''} on GitHub`,
  };

export const CHANNEL_EVENTS_MESSAGES_ZH: Record<string, ChannelEventsMessage> =
  {
    'channelEvents.title': '频道事件',
    'channelEvents.subtitle':
      '每个频道做了什么：接收或跳过了什么、发表了什么、入站任务如何流转、轮询是否正常。',
    'channelEvents.refresh': '刷新',
    'channelEvents.filterChannel': '频道',
    'channelEvents.allChannels': '全部频道',
    'channelEvents.filterType': '类型',
    'channelEvents.typeAll': '全部',
    'channelEvents.type.inbound': '入站',
    'channelEvents.type.outbound': '出站',
    'channelEvents.type.task': '任务',
    'channelEvents.type.poll': '轮询',
    'channelEvents.outcome.accepted': '已接收',
    'channelEvents.outcome.skipped': '已跳过',
    'channelEvents.outcome.posted': '已发表',
    'channelEvents.outcome.suppressed': '已抑制',
    'channelEvents.outcome.posting': '发表中',
    'channelEvents.outcome.failed': '失败',
    'channelEvents.outcome.ok': '正常',
    'channelEvents.outcome.running': '执行中',
    'channelEvents.outcome.reply_pending': '等待发表',
    'channelEvents.outcome.cancelled': '已取消',
    'channelEvents.emptyTitle': '还没有事件',
    'channelEvents.emptyDescription':
      '频道轮询、收到消息或发表回复后，事件会出现在这里。',
    'channelEvents.errorTitle': '无法加载频道事件',
    'channelEvents.unavailable': '当前工作区未启用频道管理，无法查看频道事件。',
    'channelEvents.truncated': '更早的事件未显示。',
    'channelEvents.loading': '正在加载事件…',
    'channelEvents.duration': (v) => `${v?.ms ?? 0} 毫秒`,
    'channelEvents.notifications': (v) => `${v?.count ?? 0} 条通知`,
    'channelEvents.moreFiltered': (v) => `本轮另有 ${v?.count ?? 0} 条被过滤`,
    'channelEvents.openTarget': (v) => `在 GitHub 上打开 ${v?.target ?? ''}`,
  };
