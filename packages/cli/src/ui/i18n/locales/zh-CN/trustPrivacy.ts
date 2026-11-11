/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enTrustPrivacy } from '../en/trustPrivacy.js';

export const zhCNTrustPrivacy = {
  'trust.title': '你信任此文件夹中的文件吗？',
  'trust.description':
    '请确认这是你自己的项目或来自可信来源。信任后，{cli} 可以读取、修改和执行此处的文件，并会加载本地配置（命令、Hook、MCP 服务器、智能体、技能和设置）。',
  'trust.action.trust': '信任文件夹',
  'trust.action.exit': '不信任并退出',
  'trust.discoveryErrors': '❌ 发现错误：',
  'trust.securityWarnings': '⚠️ 安全警告：',
  'trust.contains': '此文件夹包含：',
  'trust.group.commands': '命令',
  'trust.group.mcp': 'MCP 服务器',
  'trust.group.hooks': 'Hook',
  'trust.group.skills': '技能',
  'trust.group.agents': '智能体',
  'trust.group.settings': '设置覆盖',
  'trust.exiting': '当前文件夹不受信任，正在退出。',
  'trust.hint.back': 'Esc 返回',
  'permission.autoClassifierUnavailable':
    '自动安全检查暂时不可用，本次操作需要你确认。',
} as const satisfies Record<keyof typeof enTrustPrivacy, string>;
