/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Box, Text } from 'ink';
import { useSelectionList } from '../../hooks/useSelectionList.js';
import { calculateCenteredWindow } from '../../utils/calculateCenteredWindow.js';
import { figures } from '../../utils/figures.js';
import { theme } from '../../semantic-colors.js';

interface ProviderItem {
  key: string;
  value: string;
  label: string;
  sublabel?: string;
}

/** One navigation sequence, with a separate viewport and fixed title per group. */
export function ProviderSelectionList({
  items,
  customCount,
  customTitle,
  presetTitle,
  focusKey,
  customFocus,
  presetFocus,
  onHighlight,
  onSelect,
  onCancel,
}: {
  items: ProviderItem[];
  customCount: number;
  customTitle: string;
  presetTitle: string;
  focusKey?: string;
  customFocus?: string;
  presetFocus?: string;
  onHighlight: (key: string) => void;
  onSelect: (key: string) => void;
  onCancel: () => void;
}) {
  const { activeIndex } = useSelectionList({
    items,
    focusKey,
    onHighlight,
    onSelect,
    onCancel,
    showNumbers: false,
    enableNumericSelection: false,
    wrapAround: false,
  });
  const groups = [
    {
      title: customTitle,
      items: items.slice(0, customCount),
      offset: 0,
      remembered: customFocus,
      limit: 3,
    },
    {
      title: presetTitle,
      items: items.slice(customCount),
      offset: customCount,
      remembered: presetFocus,
      limit: 8,
    },
  ];
  return (
    <Box flexDirection="column">
      {groups
        .filter((group) => group.items.length)
        .map((group) => {
          const active =
            activeIndex >= group.offset &&
            activeIndex < group.offset + group.items.length;
          const localIndex = active
            ? activeIndex - group.offset
            : Math.max(
                0,
                group.items.findIndex((item) => item.key === group.remembered),
              );
          const start = calculateCenteredWindow(
            localIndex,
            group.items.length,
            group.limit,
          );
          return (
            <Box key={group.title} flexDirection="column" marginTop={1}>
              <Text bold color={theme.text.primary}>
                {group.title}
              </Text>
              {group.items
                .slice(start, start + group.limit)
                .map((item, index) => {
                  const selected = active && start + index === localIndex;
                  const scroll =
                    index === 0 && start > 0
                      ? '▲'
                      : index === group.limit - 1 &&
                          start + group.limit < group.items.length
                        ? '▼'
                        : ' ';
                  return (
                    <Box key={item.key}>
                      <Box width={3} flexShrink={0}>
                        <Text
                          color={
                            selected ? theme.ui.focus : theme.text.secondary
                          }
                        >
                          {' '}
                          {selected ? figures.pointer : scroll}
                        </Text>
                      </Box>
                      <Box flexDirection="column" flexGrow={1}>
                        <Text
                          color={selected ? theme.ui.focus : theme.text.primary}
                        >
                          {item.label}
                        </Text>
                        {item.sublabel && (
                          <Text color={theme.text.secondary}>
                            {item.sublabel}
                          </Text>
                        )}
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          );
        })}
    </Box>
  );
}
