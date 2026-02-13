/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import type { ServerLogsStepProps } from '../types.js';
import { getStatusColor, getStatusIcon } from '../utils.js';
import { MCPServerStatus, getMCPServerStatus } from '@qwen-code/qwen-code-core';

// 模拟日志条目类型
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export const ServerLogsStep: React.FC<ServerLogsStepProps> = ({
  server,
  onBack,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 生成模拟日志数据
  const generateMockLogs = useCallback((): LogEntry[] => {
    const now = new Date();
    const baseLogs: LogEntry[] = [
      {
        timestamp: new Date(now.getTime() - 5000).toISOString(),
        level: 'info',
        message: `MCP server '${server?.name}' initializing...`,
      },
      {
        timestamp: new Date(now.getTime() - 4000).toISOString(),
        level: 'info',
        message: 'Connecting to transport...',
      },
      {
        timestamp: new Date(now.getTime() - 3000).toISOString(),
        level: server?.status === MCPServerStatus.CONNECTED ? 'info' : 'error',
        message:
          server?.status === MCPServerStatus.CONNECTED
            ? 'Connection established successfully'
            : 'Connection failed: ' + (server?.errorMessage || 'Unknown error'),
      },
    ];

    if (server?.status === MCPServerStatus.CONNECTED) {
      baseLogs.push(
        {
          timestamp: new Date(now.getTime() - 2000).toISOString(),
          level: 'info',
          message: `Discovered ${server.toolCount} tools`,
        },
        {
          timestamp: new Date(now.getTime() - 1000).toISOString(),
          level: 'info',
          message: `Discovered ${server.promptCount} prompts`,
        },
        {
          timestamp: now.toISOString(),
          level: 'info',
          message: 'Server ready for requests',
        },
      );
    }

    return baseLogs;
  }, [server]);

  // 初始化日志
  useEffect(() => {
    setLogs(generateMockLogs());
  }, [generateMockLogs]);

  // 模拟实时日志更新
  useEffect(() => {
    if (!isMonitoring) return;

    const interval = setInterval(() => {
      const currentStatus = server?.name
        ? getMCPServerStatus(server.name)
        : null;

      // 如果状态变化，添加日志
      if (currentStatus && currentStatus !== server?.status) {
        const newLog: LogEntry = {
          timestamp: new Date().toISOString(),
          level: currentStatus === MCPServerStatus.CONNECTED ? 'info' : 'warn',
          message: `Server status changed to: ${currentStatus}`,
        };
        setLogs((prev) => [...prev.slice(-49), newLog]); // 保留最近50条
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isMonitoring, server]);

  // 键盘处理
  useKeypress(
    (key) => {
      if (key.name === 'escape' || key.name === 'q') {
        onBack();
      } else if (key.name === 'up') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.name === 'down') {
        setSelectedIndex((prev) => Math.min(logs.length - 1, prev + 1));
      } else if (key.name === 'm') {
        setIsMonitoring((prev) => !prev);
      }
    },
    { isActive: true },
  );

  if (!server) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No server selected')}</Text>
      </Box>
    );
  }

  const statusColor = getStatusColor(server.status);

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return theme.status.error;
      case 'warn':
        return theme.status.warning;
      case 'debug':
        return theme.text.secondary;
      default:
        return theme.text.primary;
    }
  };

  // 可视区域最大显示日志数量
  const VISIBLE_LOGS_COUNT = 15;

  // 计算可视区域的起始索引（滚动窗口）
  const scrollOffset = (() => {
    if (logs.length <= VISIBLE_LOGS_COUNT) {
      return 0;
    }
    if (selectedIndex < VISIBLE_LOGS_COUNT - 1) {
      return 0;
    }
    return Math.min(
      selectedIndex - VISIBLE_LOGS_COUNT + 1,
      logs.length - VISIBLE_LOGS_COUNT,
    );
  })();

  // 当前可视的日志列表
  const displayLogs = logs.slice(
    scrollOffset,
    scrollOffset + VISIBLE_LOGS_COUNT,
  );

  return (
    <Box flexDirection="column">
      {/* 标题栏 */}
      <Box marginBottom={1}>
        <Text bold>{t('Logs for {{name}}', { name: server.name })}</Text>
        <Text color={theme.text.secondary}>
          {' '}
          ({getStatusIcon(server.status)}{' '}
          <Text
            color={
              statusColor === 'green'
                ? theme.status.success
                : statusColor === 'yellow'
                  ? theme.status.warning
                  : theme.status.error
            }
          >
            {t(server.status)}
          </Text>
          )
        </Text>
      </Box>

      {/* 日志列表 */}
      <Box flexDirection="column" minHeight={VISIBLE_LOGS_COUNT}>
        {displayLogs.map((log, index) => {
          const actualIndex = scrollOffset + index;
          const isSelected = actualIndex === selectedIndex;
          const timestamp = new Date(log.timestamp).toLocaleTimeString();

          return (
            <Box key={actualIndex}>
              <Box minWidth={3}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                >
                  {isSelected ? '❯' : ' '}
                </Text>
              </Box>
              <Box minWidth={10}>
                <Text color={theme.text.secondary}>{timestamp}</Text>
              </Box>
              <Box minWidth={8}>
                <Text color={getLevelColor(log.level)}>
                  [{log.level.toUpperCase()}]
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                  wrap="truncate"
                >
                  {log.message}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* 滚动指示器 */}
      {logs.length > VISIBLE_LOGS_COUNT && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {scrollOffset > 0 ? '↑ ' : '  '}
            {t('{{current}}/{{total}}', {
              current: (scrollOffset + 1).toString(),
              total: logs.length.toString(),
            })}
            {scrollOffset + VISIBLE_LOGS_COUNT < logs.length ? ' ↓' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};
