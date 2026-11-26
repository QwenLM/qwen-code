/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enHelp } from '../en/help.js';

export const zhCNHelp = {
  'help.title': '帮助',
  'help.section.basics': '基础操作',
  'help.section.keyboardShortcuts': '键盘快捷键',
  'help.basics.context': '将文件或文件夹添加为上下文',
  'help.basics.shell': '直接执行 Shell 命令',
  'help.basics.commands': '查看全部可用的斜杠命令',
  'help.shortcut.newline.label': '{shortcut} 换行',
  'help.shortcut.newline.description': '插入新行',
  'help.shortcut.submit': '发送消息',
  'help.shortcut.escape': '取消或清空输入（按两次）',
  'help.shortcut.page': '向上或向下翻页',
  'help.shortcut.history': '切换历史提示词',
  'help.shortcut.editor': '在外部编辑器中打开输入',
  'help.shortcut.permissionMode': '切换接受编辑模式',
  'help.shortcut.yolo': '切换 YOLO 模式',
  'help.shortcut.clear': '清空屏幕',
  'help.shortcut.quit': '退出应用',
  'shortcuts.title': ' 快捷键',
  'shortcuts.subtitle': ' 使用 /help 查看更多',
  'shortcuts.shellMode': 'Shell 模式',
  'shortcuts.selectPath': '选择文件或文件夹',
  'shortcuts.clearRewind': '清空并回退',
  'shortcuts.yoloMode': 'YOLO 模式',
  'shortcuts.cycleMode': '切换模式',
  'shortcuts.pasteImages': '粘贴图片',
  'shortcuts.rawMarkdown': '原始 Markdown 模式',
  'shortcuts.reverseSearch': '反向搜索历史记录',
  'shortcuts.externalEditor': '打开外部编辑器',
  'shortcuts.sideQuestion': '旁路问题',
} as const satisfies Record<keyof typeof enHelp, string>;
