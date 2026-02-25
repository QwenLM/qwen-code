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
import type { ToolListStepProps, MCPToolDisplayInfo } from '../types.js';
import { VISIBLE_TOOLS_COUNT } from '../constants.js';

export const ToolListStep: React.FC<ToolListStepProps> = ({
  tools,
  serverName,
  onSelect,
  onBack,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 计算可视区域的起始索引（滚动窗口）
  const scrollOffset = useMemo(() => {
    if (tools.length <= VISIBLE_TOOLS_COUNT) {
      return 0;
    }
    // 确保选中项在可视区域内
    if (selectedIndex < VISIBLE_TOOLS_COUNT - 1) {
      return 0;
    }
    return Math.min(
      selectedIndex - VISIBLE_TOOLS_COUNT + 1,
      tools.length - VISIBLE_TOOLS_COUNT,
    );
  }, [selectedIndex, tools.length]);

  // 当前可视的工具列表
  const displayTools = useMemo(
    () => tools.slice(scrollOffset, scrollOffset + VISIBLE_TOOLS_COUNT),
    [tools, scrollOffset],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      } else if (key.name === 'up') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.name === 'down') {
        setSelectedIndex((prev) => Math.min(tools.length - 1, prev + 1));
      } else if (key.name === 'return') {
        if (tools[selectedIndex]) {
          onSelect(tools[selectedIndex]);
        }
      }
    },
    { isActive: true },
  );

  if (tools.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No tools available for this server.')}
        </Text>
      </Box>
    );
  }

  const getToolAnnotations = (tool: MCPToolDisplayInfo): string => {
    const hints: string[] = [];
    if (tool.annotations?.destructiveHint) hints.push(t('destructive'));
    if (tool.annotations?.readOnlyHint) hints.push(t('read-only'));
    if (tool.annotations?.openWorldHint) hints.push(t('open-world'));
    if (tool.annotations?.idempotentHint) hints.push(t('idempotent'));
    return hints.join(', ');
  };

  return (
    <Box flexDirection="column">
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold>{t('Tools for {{name}}', { name: serverName })}</Text>
        <Text color={theme.text.secondary}>
          {' '}
          ({tools.length} {tools.length === 1 ? t('tool') : t('tools')})
        </Text>
      </Box>

      {/* 工具列表 */}
      <Box flexDirection="column">
        {displayTools.map((tool, index) => {
          const actualIndex = scrollOffset + index;
          const isSelected = actualIndex === selectedIndex;
          const annotations = getToolAnnotations(tool);

          return (
            <Box key={tool.name}>
              <Box minWidth={4}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                >
                  {isSelected ? '❯' : ' '}
                </Text>
                <Text color={theme.text.secondary}>{actualIndex + 1}.</Text>
              </Box>
              <Text
                color={isSelected ? theme.text.accent : theme.text.primary}
                wrap="truncate"
              >
                {tool.name}
              </Text>
              {annotations && (
                <>
                  <Text color={theme.text.secondary}> </Text>
                  <Text color={theme.text.secondary}>{annotations}</Text>
                </>
              )}
            </Box>
          );
        })}
      </Box>

      {/* 滚动提示 */}
      {tools.length > VISIBLE_TOOLS_COUNT && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {scrollOffset > 0 ? '↑ ' : '  '}
            {t('{{current}}/{{total}}', {
              current: (selectedIndex + 1).toString(),
              total: tools.length.toString(),
            })}
            {scrollOffset + VISIBLE_TOOLS_COUNT < tools.length ? ' ↓' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};
