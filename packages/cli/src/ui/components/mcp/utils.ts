/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerDisplayInfo, GroupedServers } from './types.js';
import { SOURCE_DISPLAY_NAMES } from './constants.js';

/**
 * 按来源分组服务器
 */
export function groupServersBySource(
  servers: MCPServerDisplayInfo[],
): GroupedServers[] {
  const groups = new Map<string, MCPServerDisplayInfo[]>();

  for (const server of servers) {
    const existing = groups.get(server.source);
    if (existing) {
      existing.push(server);
    } else {
      groups.set(server.source, [server]);
    }
  }

  // 按优先级排序: user > project > extension
  const sourceOrder = ['user', 'project', 'extension'];
  const result: GroupedServers[] = [];

  for (const source of sourceOrder) {
    const servers = groups.get(source);
    if (servers && servers.length > 0) {
      result.push({
        source,
        displayName: SOURCE_DISPLAY_NAMES[source] || source,
        servers,
      });
    }
  }

  return result;
}

/**
 * 获取状态颜色
 */
export function getStatusColor(
  status: string,
): 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'connected':
      return 'green';
    case 'connecting':
      return 'yellow';
    case 'disconnected':
      return 'red';
    default:
      return 'gray';
  }
}

/**
 * 获取状态图标
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case 'connected':
      return '✓';
    case 'connecting':
      return '…';
    case 'disconnected':
      return '✗';
    default:
      return '?';
  }
}

/**
 * 截断文本
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * 格式化服务器命令显示
 */
export function formatServerCommand(server: MCPServerDisplayInfo): string {
  const config = server.config;
  if (config.httpUrl) {
    return `${config.httpUrl} (http)`;
  }
  if (config.url) {
    return `${config.url} (sse)`;
  }
  if (config.command) {
    const args = config.args?.join(' ') || '';
    return `${config.command} ${args} (stdio)`.trim();
  }
  return 'Unknown';
}
