/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type FilterMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

function recordNoun(count: string | number | undefined) {
  return Number(count ?? 0) === 1 ? 'record' : 'records';
}

export const TRAJECTORY_FILTER_MESSAGES_EN: Record<string, FilterMessage> = {
  'trajectory.filter.search': 'Search loaded records…',
  'trajectory.filter.type': 'Record type',
  'trajectory.filter.type.all': 'All types',
  'trajectory.filter.type.request': 'Requests',
  'trajectory.filter.type.tool': 'Tools',
  'trajectory.filter.type.user': 'User input',
  'trajectory.filter.type.message': 'Messages',
  'trajectory.filter.type.other': 'Other',
  'trajectory.filter.status': 'Execution status',
  'trajectory.filter.status.all': 'All statuses',
  'trajectory.filter.status.success': 'Success',
  'trajectory.filter.status.error': 'Failed',
  'trajectory.filter.status.cancelled': 'Cancelled',
  'trajectory.filter.status.running': 'In progress',
  'trajectory.filter.status.unknown': 'Unknown',
  'trajectory.filter.count': (v) =>
    `${v?.count ?? 0} matching ${recordNoun(v?.count)}`,
  'trajectory.filter.position': (v) =>
    `Result ${v?.position ?? 0} / ${v?.count ?? 0}`,
  'trajectory.filter.previous': 'Previous',
  'trajectory.filter.next': 'Next',
  'trajectory.filter.clear': 'Clear filters',
  'trajectory.filter.empty': 'No matches in the current search scope.',
  'trajectory.filter.truncated': (v) =>
    `Some recorded text is excluded from search (${v?.count ?? 0} ${recordNoun(v?.count)}).`,
  'trajectory.filter.hidden': 'This record does not match the current filters.',
};

export const TRAJECTORY_FILTER_MESSAGES_ZH: Record<string, FilterMessage> = {
  'trajectory.filter.search': '搜索已加载记录…',
  'trajectory.filter.type': '记录类型',
  'trajectory.filter.type.all': '全部类型',
  'trajectory.filter.type.request': '请求',
  'trajectory.filter.type.tool': '工具',
  'trajectory.filter.type.user': '用户输入',
  'trajectory.filter.type.message': '消息',
  'trajectory.filter.type.other': '其他',
  'trajectory.filter.status': '执行状态',
  'trajectory.filter.status.all': '全部状态',
  'trajectory.filter.status.success': '成功',
  'trajectory.filter.status.error': '失败',
  'trajectory.filter.status.cancelled': '取消',
  'trajectory.filter.status.running': '进行中',
  'trajectory.filter.status.unknown': '未知',
  'trajectory.filter.count': (v) => `匹配 ${v?.count ?? 0} 条`,
  'trajectory.filter.position': (v) =>
    `第 ${v?.position ?? 0} / ${v?.count ?? 0} 条`,
  'trajectory.filter.previous': '上一条',
  'trajectory.filter.next': '下一条',
  'trajectory.filter.clear': '清除筛选',
  'trajectory.filter.empty': '当前搜索范围内无匹配。',
  'trajectory.filter.truncated': (v) =>
    `部分已记录正文未纳入搜索（${v?.count ?? 0} 条记录）。`,
  'trajectory.filter.hidden': '此记录不符合当前筛选。',
};
