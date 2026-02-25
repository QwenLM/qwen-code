/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import type { ServerListStepProps, MCPServerDisplayInfo } from '../types.js';
import {
  groupServersBySource,
  getStatusIcon,
  getStatusColor,
} from '../utils.js';

export const ServerListStep: React.FC<ServerListStepProps> = ({
  servers,
  onSelect,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const groupedServers = useMemo(
    () => groupServersBySource(servers),
    [servers],
  );

  // 计算扁平化的服务器列表用于导航
  const flatServers = useMemo(() => {
    const result: MCPServerDisplayInfo[] = [];
    for (const group of groupedServers) {
      result.push(...group.servers);
    }
    return result;
  }, [groupedServers]);

  // 键盘导航
  useKeypress(
    (key) => {
      if (key.name === 'up') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.name === 'down') {
        setSelectedIndex((prev) => Math.min(flatServers.length - 1, prev + 1));
      } else if (key.name === 'return') {
        onSelect(selectedIndex);
      }
    },
    { isActive: true },
  );

  if (servers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No MCP servers configured.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Add MCP servers to your settings to get started.')}
        </Text>
      </Box>
    );
  }

  // 计算当前选中项在分组中的位置
  const getSelectionPosition = (globalIndex: number) => {
    let currentIndex = 0;
    for (const group of groupedServers) {
      if (globalIndex < currentIndex + group.servers.length) {
        return {
          groupIndex: groupedServers.indexOf(group),
          itemIndex: globalIndex - currentIndex,
        };
      }
      currentIndex += group.servers.length;
    }
    return { groupIndex: 0, itemIndex: 0 };
  };

  const currentPosition = getSelectionPosition(selectedIndex);

  return (
    <Box flexDirection="column">
      {/* 服务器统计 */}
      <Box marginBottom={1}>
        <Text color={theme.text.secondary}>
          {servers.length} {servers.length === 1 ? t('server') : t('servers')}
        </Text>
      </Box>

      {/* 分组服务器列表 */}
      {groupedServers.map((group, groupIndex) => (
        <Box key={group.source} flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            {group.displayName}
            {group.servers[0]?.configPath && (
              <Text color={theme.text.secondary}>
                {' '}
                ({group.servers[0].configPath})
              </Text>
            )}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {group.servers.map((server, itemIndex) => {
              const isSelected =
                groupIndex === currentPosition.groupIndex &&
                itemIndex === currentPosition.itemIndex;
              const statusColor = getStatusColor(server.status);

              return (
                <Box key={server.name}>
                  <Box minWidth={2}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                    >
                      {isSelected ? '❯' : ' '}
                    </Text>
                  </Box>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                    wrap="truncate"
                  >
                    {server.name}
                  </Text>
                  <Text color={theme.text.secondary}> · </Text>
                  <Text
                    color={
                      statusColor === 'green'
                        ? theme.status.success
                        : statusColor === 'yellow'
                          ? theme.status.warning
                          : theme.status.error
                    }
                  >
                    {getStatusIcon(server.status)}
                  </Text>
                  <Text
                    color={
                      statusColor === 'green'
                        ? theme.status.success
                        : statusColor === 'yellow'
                          ? theme.status.warning
                          : theme.status.error
                    }
                  >
                    {' '}
                    {t(server.status)}
                  </Text>
                  {/* 显示 Scope 和禁用状态 */}
                  <Text color={theme.text.secondary}> [{server.scope}]</Text>
                  {server.isDisabled && (
                    <Text color={theme.status.warning}> {t('(disabled)')}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}

      {/* 提示信息 */}
      {servers.some((s) => s.status === 'disconnected') && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            ※ {t('Run qwen --debug to see error logs')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
