/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import {
  type Extension,
  getExtensionDisplayName,
  getExtensionDescription,
} from '@qwen-code/qwen-code-core';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { t, getCurrentLanguage } from '../../../../i18n/index.js';
import { ExtensionUpdateState } from '../../../state/extensions.js';

interface ExtensionListStepProps {
  extensions: Extension[];
  extensionsUpdateState: Map<string, string>;
  onExtensionSelect: (extensionIndex: number) => void;
}

export const ExtensionListStep = ({
  extensions,
  extensionsUpdateState,
  onExtensionSelect,
}: ExtensionListStepProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { columns: termWidth } = useTerminalSize();

  // Calculate max widths for each column for alignment
  const { maxNameWidth, maxStatusWidth } = useMemo(() => {
    let maxName = 0;
    let maxStatus = 0;
    for (const ext of extensions) {
      maxName = Math.max(
        maxName,
        getExtensionDisplayName(ext, getCurrentLanguage()).length,
      );
      const statusLength = ext.isActive
        ? t('active').length
        : t('disabled').length;
      maxStatus = Math.max(maxStatus, statusLength);
    }
    return {
      maxNameWidth: maxName,
      maxStatusWidth: maxStatus,
    };
  }, [extensions]);

  // Reset selection when extensions change
  useEffect(() => {
    if (extensions.length > 0 && selectedIndex >= extensions.length) {
      setSelectedIndex(0);
    }
  }, [extensions, selectedIndex]);

  // Keyboard navigation
  useKeypress(
    (key) => {
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : extensions.length - 1,
        );
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) =>
          prev < extensions.length - 1 ? prev + 1 : 0,
        );
      } else if (key.name === 'return' || key.name === 'space') {
        if (extensions.length > 0) {
          onExtensionSelect(selectedIndex);
        }
      }
    },
    { isActive: true },
  );

  if (extensions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No extensions installed.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t("Use '/extensions install' to install your first extension.")}
        </Text>
      </Box>
    );
  }

  const getUpdateStateColor = (state: string | undefined): string => {
    if (!state) return theme.text.secondary;

    switch (state) {
      case ExtensionUpdateState.CHECKING_FOR_UPDATES:
      case ExtensionUpdateState.UPDATING:
        return theme.text.secondary;
      case ExtensionUpdateState.UPDATE_AVAILABLE:
      case ExtensionUpdateState.UPDATED_NEEDS_RESTART:
        return theme.status.warning;
      case ExtensionUpdateState.ERROR:
        return theme.status.error;
      case ExtensionUpdateState.UP_TO_DATE:
      case ExtensionUpdateState.NOT_UPDATABLE:
      case ExtensionUpdateState.UPDATED:
        return theme.status.success;
      default:
        return theme.text.secondary;
    }
  };

  const getLocalizedUpdateState = (state: string | undefined): string => {
    if (!state) return '';
    // Map internal state values to translation keys
    const stateMap: Record<string, string> = {
      'up to date': t('up to date'),
      'update available': t('update available'),
      'checking...': t('checking...'),
      'not updatable': t('not updatable'),
      error: t('error'),
    };
    return stateMap[state] || state;
  };

  const truncateDescription = (
    text: string,
    maxWidth: number,
    maxLines: number,
  ): string[] => {
    if (maxWidth <= 0) return [];
    const lines: string[] = [];
    let remaining = text;
    for (let i = 0; i < maxLines; i++) {
      if (!remaining) break;
      if (remaining.length <= maxWidth || i === maxLines - 1) {
        lines.push(
          remaining.length > maxWidth
            ? remaining.slice(0, maxWidth - 1) + '…'
            : remaining,
        );
        break;
      }
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    return lines;
  };

  const renderExtensionItem = (
    extension: Extension,
    index: number,
    isSelected: boolean,
  ) => {
    const locale = getCurrentLanguage();
    const isActive = extension.isActive;
    const activeColor = isActive ? theme.status.success : theme.text.secondary;
    const activeString = isActive ? t('active') : t('disabled');

    const updateState = extensionsUpdateState.get(extension.name);
    const stateColor = getUpdateStateColor(updateState);
    const stateText = getLocalizedUpdateState(updateState);

    const description = getExtensionDescription(extension, locale);
    // selector(2) + name + gap(2) + status + gap(2) + update state
    const fixedWidth = 2 + maxNameWidth + 2 + maxStatusWidth + 4 + 15;
    const descWidth = Math.max(0, termWidth - fixedWidth);
    const descLines = description
      ? truncateDescription(description, descWidth, 2)
      : [];

    return (
      <Box key={extension.name} flexDirection="column" marginBottom={descLines.length > 0 ? 1 : 0}>
        <Box alignItems="center">
          <Box minWidth={2} flexShrink={0}>
            <Text color={isSelected ? theme.text.accent : theme.text.primary}>
              {isSelected ? '●' : ' '}
            </Text>
          </Box>
          <Box width={maxNameWidth} flexShrink={0}>
            <Text
              color={isSelected ? theme.text.accent : theme.text.primary}
              wrap="truncate"
            >
              {getExtensionDisplayName(extension, locale)}
            </Text>
          </Box>
          <Box width={maxStatusWidth + 4} flexShrink={0}>
            <Text color={activeColor}>  ({activeString})</Text>
          </Box>
          {stateText && <Text color={stateColor}>[{stateText}]</Text>}
        </Box>
        {descLines.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {descLines.map((line, i) => (
              <Text key={i} color={theme.text.secondary}>{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.text.secondary}>
          {t('{{count}} extensions installed', {
            count: extensions.length.toString(),
          })}
        </Text>
      </Box>
      <Box flexDirection="column">
        {extensions.map((extension, index) =>
          renderExtensionItem(extension, index, index === selectedIndex),
        )}
      </Box>
    </Box>
  );
};
