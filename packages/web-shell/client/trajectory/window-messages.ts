/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type WindowMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const TRAJECTORY_WINDOW_MESSAGES_EN: Record<string, WindowMessage> = {
  'trajectory.window.navigation': 'Trajectory history',
  'trajectory.window.latest': 'Latest read window',
  'trajectory.window.history': 'Historical window',
  'trajectory.window.outside':
    'Earlier records outside this window are not loaded.',
  'trajectory.window.scope': 'Metrics and search cover only this window.',
  'trajectory.window.older': 'Earlier segment',
  'trajectory.window.newer': 'Newer segment',
  'trajectory.window.return': 'Back to latest',
  'trajectory.window.start': 'Reached the earliest records in this snapshot.',
  'trajectory.window.released':
    'Newer navigation bookmarks were released. Return to latest to read newer records.',
  'trajectory.window.changed': 'Window changed. Select a record to inspect it.',
  'trajectory.window.failed':
    'Navigation failed; the displayed window is retained.',
  'trajectory.window.expired':
    'This history snapshot is unavailable. Return to latest.',
  'trajectory.window.protocol':
    'History could not continue: the page cursor did not advance. Return to latest.',
  'trajectory.window.budget':
    'The history cursor exceeds the navigation budget. Return to latest.',
  'trajectory.window.pages': (v) =>
    `${v?.pages ?? 0} ${Number(v?.pages) === 1 ? 'page' : 'pages'}`,
};

export const TRAJECTORY_WINDOW_MESSAGES_ZH: Record<string, WindowMessage> = {
  'trajectory.window.navigation': '轨迹历史导航',
  'trajectory.window.latest': '最新读取的窗口',
  'trajectory.window.history': '历史窗口',
  'trajectory.window.outside': '当前窗口之前的更早记录没有加载。',
  'trajectory.window.scope': '指标与搜索仅覆盖当前窗口。',
  'trajectory.window.older': '更早一段',
  'trajectory.window.newer': '较新一段',
  'trajectory.window.return': '回到最新',
  'trajectory.window.start': '已到当前快照的最早记录。',
  'trajectory.window.released':
    '较新历史导航记录已释放，可回到最新读取较新记录。',
  'trajectory.window.changed': '已切换窗口，请重新选择记录查看详情。',
  'trajectory.window.failed': '导航失败，当前窗口仍可阅读。',
  'trajectory.window.expired': '历史快照已不可用，请回到最新。',
  'trajectory.window.protocol':
    '历史读取无法继续：分页游标没有推进。请回到最新。',
  'trajectory.window.budget': '历史游标超过导航预算，请回到最新。',
  'trajectory.window.pages': (v) => `${v?.pages ?? 0} 页`,
};
