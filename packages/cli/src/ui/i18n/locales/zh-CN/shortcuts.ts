/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enShortcuts } from '../en/shortcuts.js';

export const zhCNShortcuts = {
  'shortcut.tabSwitch': 'Tab/←→ 切换',
  'shortcut.tabOnlySwitch': 'Tab 切换',
  'shortcut.arrowSwitch': '←→ 切换',
  'shortcut.navigate': '↑↓ 导航',
  'shortcut.select': 'Enter 选择',
  'shortcut.confirm': 'Enter 确认',
  'shortcut.toggle': 'Enter 切换',
  'shortcut.enterToList': 'Enter 进入列表',
  'shortcut.cancel': 'Esc 取消',
  'shortcut.close': 'Esc 关闭',
  'shortcut.back': 'Esc 返回',
  'shortcut.cancelSearch': 'Esc 取消搜索',
  'shortcut.search': '/ 搜索',
  'shortcut.sessionOnly': 's 仅本次会话',
  'shortcut.refresh': 'r 刷新',
  'shortcut.restartApply': 'r 退出并应用',
  'shortcut.tabToggle': 'Tab 切换',
  'shortcut.questionShortcuts': '按 ? 查看快捷键',
  'shortcut.tabTwiceMore': '连续按两次 Tab 查看更多',
} as const satisfies Record<keyof typeof enShortcuts, string>;
