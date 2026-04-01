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

  const serverNameWidth = useMemo(() => {
    if (servers.length === 0) return 20;
    const maxLength = Math.max(...servers.map((s) => s.name.length));
    // 最小 20，最大 35，留一些余量
    return Math.min(Math.max(maxLength + 2, 20), 35);
  }, [servers]);

  const flatServers = useMemo(() => {
    const result: MCPServerDisplayInfo[] = [];
    for (const group of groupedServers) {
      result.push(...group.servers);
    }
    return result;
  }, [groupedServers]);

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
      {/* 分组服务器列表 */}
      {groupedServers.map((group, groupIndex) => (
        <Box
          key={group.source}
          flexDirection="column"
          marginBottom={groupIndex === groupedServers.length - 1 ? 0 : 1}
        >
          <Text bold color={theme.text.primary}>
            {`  ${group.displayName}`}
            {group.servers[0]?.configPath && (
              <Text color={theme.text.secondary}>
                {' '}
                ({group.servers[0].configPath})
              </Text>
            )}
          </Text>
          <Box flexDirection="column">
            {group.servers.map((server, itemIndex) => {
              const isSelected =
                groupIndex === currentPosition.groupIndex &&
                itemIndex === currentPosition.itemIndex;
              const statusColor = server.isDisabled
                ? 'yellow'
                : getStatusColor(server.status);

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
                  {/* 服务器名称 - 固定宽度 */}
                  <Box width={serverNameWidth}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                      wrap="truncate"
                    >
                      {server.name}
                    </Text>
                  </Box>
                  <Text color={theme.text.secondary}> · </Text>
                  {/* 状态图标和文本 */}
                  <Text
                    color={
                      statusColor === 'green'
                        ? theme.status.success
                        : statusColor === 'yellow'
                          ? theme.status.warning
                          : theme.status.error
                    }
                  >
                    {getStatusIcon(server.status)}{' '}
                    {server.isDisabled ? t('disabled') : t(server.status)}
                  </Text>
                  {/* 显示无效工具警告 */}
                  {!!server.invalidToolCount && server.invalidToolCount > 0 && (
                    <Text color={theme.status.warning}>
                      {' '}
                      {t('{{count}} invalid tools', {
                        count: String(server.invalidToolCount),
                      })}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}

      {/* 提示信息 */}
      {servers.some((s) => s.status === 'disconnected' && !s.isDisabled) && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            ※ {t('Run proto --debug to see error logs')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
