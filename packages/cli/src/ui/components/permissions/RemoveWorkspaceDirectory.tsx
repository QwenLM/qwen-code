/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { theme } from '../../semantic-colors.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface RemoveWorkspaceDirectoryProps {
  /** Directory path that the user is about to remove. */
  directory: string;
  /** Whether this directory will also be stripped from settings.local.json. */
  isPersisted: boolean;
  /** Confirm removal. */
  onConfirm: () => void;
  /** Cancel and return to the workspace list. */
  onCancel: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Confirmation sub-screen rendered when the user presses `x` on a workspace
 * directory in the /permissions Trust tab. The explicit Yes/No selection
 * prevents accidental loss of trusted directories — especially persisted
 * ones whose removal also touches settings.local.json on disk.
 */
export function RemoveWorkspaceDirectory({
  directory,
  isPersisted,
  onConfirm,
  onCancel,
}: RemoveWorkspaceDirectoryProps): React.JSX.Element {
  useRegisterKeyboardContext('Dialog', true);

  const items = useMemo(
    () => [
      { key: 'yes', label: 'Yes, remove this directory', value: 'yes' as const },
      { key: 'no', label: 'No, keep it', value: 'no' as const },
    ],
    [],
  );

  const handleConfirm = useCallback(
    (value: 'yes' | 'no') => {
      if (value === 'yes') {
        onConfirm();
      } else {
        onCancel();
      }
    },
    [onConfirm, onCancel],
  );

  const handleKey = useCallback(
    (key: Key) => {
      if (key.name === 'escape') {
        onCancel();
        return true;
      }
      return false;
    },
    [onCancel],
  );
  useKeypress(handleKey, { isActive: true });

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.status.error}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold color={theme.status.error}>
          Remove workspace directory?
        </Text>
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text bold>{directory}</Text>
          {isPersisted ? (
            <Text dimColor>
              This entry is persisted in settings.local.json and will be
              removed from disk as well.
            </Text>
          ) : (
            <Text dimColor>
              This entry only exists for the current session.
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text>Are you sure you want to remove it from the workspace?</Text>
        </Box>
        <RadioButtonSelect
          items={items}
          onSelect={handleConfirm}
          isFocused={true}
        />
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
