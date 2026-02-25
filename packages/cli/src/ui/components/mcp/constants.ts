/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP管理相关常量
 */

/**
 * 最大显示工具数量
 */
export const MAX_DISPLAY_TOOLS = 10;

/**
 * 最大显示prompt数量
 */
export const MAX_DISPLAY_PROMPTS = 10;

/**
 * 日志列表可视区域最大显示数量
 */
export const VISIBLE_LOGS_COUNT = 15;

/**
 * 工具列表可视区域最大显示数量
 */
export const VISIBLE_TOOLS_COUNT = 10;

/**
 * 分组显示名称映射
 */
export const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  user: 'User MCPs',
  project: 'Project MCPs',
  extension: 'Extension MCPs',
};

/**
 * 状态显示文本
 */
export const STATUS_TEXT: Record<string, string> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'failed',
};
