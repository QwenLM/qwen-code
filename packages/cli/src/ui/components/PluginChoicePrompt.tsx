/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useState, useCallback, useMemo } from 'react';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';

interface PluginChoice {
  name: string;
  description?: string;
}

type PluginChoicePromptProps = {
  marketplaceName: string;
  plugins: PluginChoice[];
  onSelect: (pluginName: string) => void;
  onCancel: () => void;
  terminalWidth: number;
};

// Maximum number of visible items in the list
const MAX_VISIBLE_ITEMS = 8;

export const PluginChoicePrompt = (props: PluginChoicePromptProps) => {
  const { marketplaceName, plugins, onSelect, onCancel } = props;

  const [selectedIndex, setSelectedIndex] = useState(0);

  const prefixWidth = 2; // "❯ " or "  "

  const handleKeypress = useCallback(
    (key: Key) => {
      const { name, sequence } = key;

      if (name === 'escape') {
        onCancel();
        return;
      }

      if (name === 'return') {
        const plugin = plugins[selectedIndex];
        if (plugin) {
          onSelect(plugin.name);
        }
        return;
      }

      // Navigate up
      if (name === 'up' || sequence === 'k') {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : plugins.length - 1));
        return;
      }

      // Navigate down
      if (name === 'down' || sequence === 'j') {
        setSelectedIndex((prev) => (prev < plugins.length - 1 ? prev + 1 : 0));
        return;
      }

      // Number shortcuts (1-9)
      const num = parseInt(sequence || '', 10);
      if (!isNaN(num) && num >= 1 && num <= plugins.length && num <= 9) {
        setSelectedIndex(num - 1);
        const plugin = plugins[num - 1];
        if (plugin) {
          onSelect(plugin.name);
        }
      }
    },
    [plugins, selectedIndex, onSelect, onCancel],
  );

  useKeypress(handleKeypress, { isActive: true });

  // Calculate visible range for scrolling
  const { visiblePlugins, startIndex, hasMore, hasLess } = useMemo(() => {
    const total = plugins.length;
    if (total <= MAX_VISIBLE_ITEMS) {
      return {
        visiblePlugins: plugins,
        startIndex: 0,
        hasMore: false,
        hasLess: false,
      };
    }

    // Calculate window position to keep selected item visible
    let start = 0;
    const halfWindow = Math.floor(MAX_VISIBLE_ITEMS / 2);

    if (selectedIndex <= halfWindow) {
      // Near the beginning
      start = 0;
    } else if (selectedIndex >= total - halfWindow) {
      // Near the end
      start = total - MAX_VISIBLE_ITEMS;
    } else {
      // In the middle - center on selected
      start = selectedIndex - halfWindow;
    }

    const end = Math.min(start + MAX_VISIBLE_ITEMS, total);

    return {
      visiblePlugins: plugins.slice(start, end),
      startIndex: start,
      hasLess: start > 0,
      hasMore: end < total,
    };
  }, [plugins, selectedIndex]);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
      width="100%"
    >
      <Text bold color={theme.text.accent}>
        {t('Select a plugin from "{{name}}"', { name: marketplaceName })}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {/* Show "more items above" indicator */}
        {hasLess && (
          <Box>
            <Text dimColor>
              {' '}
              ↑ {t('{{count}} more above', { count: String(startIndex) })}
            </Text>
          </Box>
        )}

        {visiblePlugins.map((plugin, visibleIndex) => {
          const actualIndex = startIndex + visibleIndex;
          const isSelected = actualIndex === selectedIndex;
          const prefix = isSelected ? '❯ ' : '  ';

          return (
            <Box key={plugin.name} flexDirection="column">
              <Box flexDirection="row">
                <Text color={isSelected ? theme.text.accent : undefined}>
                  {prefix}
                </Text>
                <Text
                  bold={isSelected}
                  color={isSelected ? theme.text.accent : undefined}
                >
                  {plugin.name}
                </Text>
              </Box>
              {/* Show full description only for selected item */}
              {isSelected && plugin.description && (
                <Box marginLeft={prefixWidth}>
                  <Text color={theme.text.accent}>{plugin.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* Show "more items below" indicator */}
        {hasMore && (
          <Box>
            <Text dimColor>
              {' '}
              ↓{' '}
              {t('{{count}} more below', {
                count: String(plugins.length - startIndex - MAX_VISIBLE_ITEMS),
              })}
            </Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text dimColor>
          {t('Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel')}
        </Text>
        {plugins.length > MAX_VISIBLE_ITEMS && (
          <Text dimColor>
            ({selectedIndex + 1}/{plugins.length})
          </Text>
        )}
      </Box>
    </Box>
  );
};
