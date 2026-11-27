/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enHome } from '../en/home.js';

export const zhCNHome = {
  'home.model': '{model}（使用 /model 切换）',
  'home.endpoint': '端点：{endpoint}',
  'home.tips.title': '快速入门提示',
  'home.tips.context': '1. 使用 {filename} 文件自定义交互方式',
  'home.tips.help': '2. 使用 /help 查看更多信息',
  'home.tips.tasks': '3. 可以询问代码、编辑代码或运行命令',
  'home.tips.specific': '4. 描述越具体，结果越准确',
  'home.whatsNew.title': 'v{version} 新增内容：',
  'home.releaseNotes.more': '使用 {command} 查看更多',
  'home.releaseNotes.title': '版本更新',
  'home.releaseNotes.empty': '暂无版本更新，后台正在获取，请稍后重试。',
} as const satisfies Record<keyof typeof enHome, string>;
