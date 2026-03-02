/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { type Extension } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';
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

  // Reset selection when extensions change
  useEffect(() => {
    if (extensions.length > 0 && selectedIndex >= extensions.length) {
      setSelectedIndex(0);
    }
  }, [extensions, selectedIndex]);

  // Keyboard navigation
  useKeypress(
    (key) => {
      if (key.name === 'up' || key.name === 'k') {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : extensions.length - 1,
        );
      } else if (key.name === 'down' || key.name === 'j') {
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

  const renderExtensionItem = (
    extension: Extension,
    index: number,
    isSelected: boolean,
  ) => {
    const isActive = extension.isActive;
    const activeColor = isActive ? theme.status.success : theme.text.secondary;
    const activeString = isActive ? t('active') : t('disabled');

    const updateState = extensionsUpdateState.get(extension.name);
    const stateColor = getUpdateStateColor(updateState);
    const stateText = getLocalizedUpdateState(updateState);

    return (
      <Box key={extension.name} alignItems="center">
        <Box minWidth={2} flexShrink={0}>
          <Text color={isSelected ? theme.text.accent : theme.text.primary}>
            {isSelected ? '●' : ' '}
          </Text>
        </Box>
        <Text
          color={isSelected ? theme.text.accent : theme.text.primary}
          wrap="truncate"
        >
          {extension.name}
          <Text color={theme.text.secondary}> v{extension.version}</Text>
          <Text color={activeColor}> ({activeString})</Text>
          {stateText && <Text color={stateColor}> [{stateText}]</Text>}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        {extensions.map((extension, index) =>
          renderExtensionItem(extension, index, index === selectedIndex),
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('{{count}} extensions installed', {
            count: extensions.length.toString(),
          })}
        </Text>
      </Box>
    </Box>
  );
};
