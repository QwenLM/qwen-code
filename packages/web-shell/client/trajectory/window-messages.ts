/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type WindowMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

function plural(count: string | number | undefined, noun: string): string {
  const n = Number(count ?? 0);
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export const TRAJECTORY_WINDOW_MESSAGES_EN: Record<string, WindowMessage> = {
  'trajectory.summary.elapsed': 'elapsed',
  'trajectory.summary.active': 'active',
  'trajectory.summary.model': 'model',
  'trajectory.summary.requests': (v) => plural(v?.count, 'request'),
  'trajectory.summary.tools': (v) => plural(v?.count, 'tool'),
  'trajectory.summary.tokens': 'tokens',
  'trajectory.summary.failed': (v) => `${v?.count ?? 0} failed`,
  'trajectory.summary.failedFilter': 'Show only failed records',
  'trajectory.pill.live': 'Live',
  'trajectory.pill.connecting': 'Connecting…',
  'trajectory.pill.reconnecting': 'Reconnecting…',
  'trajectory.pill.paused': 'Paused',
  'trajectory.pill.returning': 'Updating…',
  'trajectory.pill.history': 'Earlier window',
  'trajectory.pill.pause': 'Pause following',
  'trajectory.pill.resume': 'Return to latest',
  'trajectory.jumpLatest': 'Jump to latest',
  'trajectory.jumpLatest.updated': 'New executions arrived',
  'trajectory.warnings': 'Warnings',
  'trajectory.about': 'About this view',
  'trajectory.about.scope': (v) =>
    `Totals cover the loaded records: ${plural(v?.pages, 'page')}, ${plural(v?.turns, 'turn')}. Selection and zoom don't change them.`,
  'trajectory.about.tokens':
    'Tokens: main-session input → output. Cached input is part of input.',
  'trajectory.about.numbering':
    'Request numbers count from the start of the loaded records.',
  'trajectory.boundary.earlier': 'Earlier records aren’t loaded',
  'trajectory.boundary.loadEarlier': 'Load earlier',
  'trajectory.boundary.start': 'Start of session',
  'trajectory.boundary.newer': 'Newer records',
  'trajectory.window.outside':
    'Earlier records outside this window are not loaded.',
  'trajectory.window.return': 'Back to latest',
  'trajectory.window.released':
    'Newer navigation bookmarks were released. Return to latest to read newer records.',
  'trajectory.window.failed':
    'Navigation failed; the displayed window is retained.',
  'trajectory.window.expired':
    'This history snapshot is unavailable. Return to latest.',
  'trajectory.window.protocol':
    'History could not continue: the page cursor did not advance. Return to latest.',
  'trajectory.window.budget':
    'The history cursor exceeds the navigation budget. Return to latest.',
};

export const TRAJECTORY_WINDOW_MESSAGES_ZH: Record<string, WindowMessage> = {
  'trajectory.summary.elapsed': '总历时',
  'trajectory.summary.active': '活跃',
  'trajectory.summary.model': '模型',
  'trajectory.summary.requests': (v) => `${v?.count ?? 0} 次请求`,
  'trajectory.summary.tools': (v) => `${v?.count ?? 0} 次工具`,
  'trajectory.summary.tokens': 'token',
  'trajectory.summary.failed': (v) => `${v?.count ?? 0} 项失败`,
  'trajectory.summary.failedFilter': '只看失败记录',
  'trajectory.pill.live': '实时',
  'trajectory.pill.connecting': '正在连接…',
  'trajectory.pill.reconnecting': '正在重连…',
  'trajectory.pill.paused': '已暂停',
  'trajectory.pill.returning': '正在更新…',
  'trajectory.pill.history': '更早的记录',
  'trajectory.pill.pause': '暂停跟随',
  'trajectory.pill.resume': '回到最新',
  'trajectory.jumpLatest': '跳到最新',
  'trajectory.jumpLatest.updated': '有新的执行',
  'trajectory.warnings': '警告',
  'trajectory.about': '关于此视图',
  'trajectory.about.scope': (v) =>
    `总计只统计已加载的记录：${v?.pages ?? 0} 页、${v?.turns ?? 0} 轮。时间框选和缩放不影响总计。`,
  'trajectory.about.tokens': 'token：主会话的输入 → 输出，缓存输入计入输入。',
  'trajectory.about.numbering': '请求序号从已加载记录的开头计数。',
  'trajectory.boundary.earlier': '更早的记录未加载',
  'trajectory.boundary.loadEarlier': '加载更早记录',
  'trajectory.boundary.start': '会话开始',
  'trajectory.boundary.newer': '较新的记录',
  'trajectory.window.outside': '当前窗口之前的更早记录没有加载。',
  'trajectory.window.return': '回到最新',
  'trajectory.window.released':
    '较新历史导航记录已释放，可回到最新读取较新记录。',
  'trajectory.window.failed': '导航失败，当前窗口仍可阅读。',
  'trajectory.window.expired': '历史快照已不可用，请回到最新。',
  'trajectory.window.protocol':
    '历史读取无法继续：分页游标没有推进。请回到最新。',
  'trajectory.window.budget': '历史游标超过导航预算，请回到最新。',
};
