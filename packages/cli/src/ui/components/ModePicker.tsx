/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import type { ModeConfig } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';

interface ModePickerProps {
  config: Config | null;
  onSelect: (modeName: string) => void;
  onCancel: () => void;
}

/**
 * Interactive mode picker dialog.
 * Displayed when user presses 'M' key.
 */
export const ModePicker: React.FC<ModePickerProps> = ({
  config,
  onSelect,
  onCancel,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const modes = config?.getModeManager().getAvailableModes() ?? [];
  const currentMode = config?.getCurrentMode();
  const currentName = currentMode?.config.name;

  // Find index of current mode
  React.useEffect(() => {
    if (currentName) {
      const idx = modes.findIndex((m) => m.name === currentName);
      if (idx >= 0) {
        setSelectedIndex(idx);
      }
    }
  }, [currentName, modes]);

  const handleSelect = useCallback(() => {
    if (modes[selectedIndex]) {
      onSelect(modes[selectedIndex].name);
    }
  }, [modes, selectedIndex, onSelect]);

  useInput(
    (input: string, key: { name: string; ctrl: boolean; escape: boolean }) => {
      if (key.escape || key.ctrl) {
        onCancel();
        return;
      }

      switch (input) {
        case 'up':
        case 'k':
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;
        case 'down':
        case 'j':
          setSelectedIndex((prev) => Math.min(modes.length - 1, prev + 1));
          break;
        case 'return':
          handleSelect();
          break;
      }
    },
  );

  if (modes.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.text.secondary}>No modes available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={60}>
      <Box>
        <Text bold color={theme.ui.accent}>
          Select Mode
        </Text>
        <Text color={theme.text.secondary}>
          {' '}(↑↓ navigate, enter select, esc cancel)
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {modes.map((mode, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = mode.name === currentName;
          const color = mode.color || theme.ui.accent;

          return (
            <Box key={mode.name}>
              <Text color={isSelected ? color : theme.text.secondary}>
                {isSelected ? '▸ ' : '  '}
                {mode.icon} {mode.displayName}
                {isCurrent && !isSelected ? ' (current)' : ''}
              </Text>
              {isSelected && (
                <Text color={theme.text.secondary}>
                  {' '}
                  — {mode.description}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
