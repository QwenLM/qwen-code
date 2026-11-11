/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../shared/RadioButtonSelect.js';
import { DirectoryPathInput } from '../shared/DirectoryPathInput.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import type { AddDirTrustChoice } from '../../commands/AddDirTrustSelector.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface AddWorkspaceDirectoryProps {
  /** Resolved (real) path + trust choice are reported on success. */
  onSubmit: (resolvedPath: string, choice: AddDirTrustChoice) => void;
  /** Cancel and return to the workspace list. */
  onCancel: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * In-dialog flow for adding a directory to the workspace context.
 *
 * Two-step state machine:
 *   1. Path input  — delegated to DirectoryPathInput, which shares its
 *      completion state machine with the main prompt (highlighting,
 *      Tab-apply, Enter-on-highlight, scroll window).
 *   2. Trust choice — "session only" vs "remember across sessions".
 *
 * The actual write into the permission context and settings file is
 * delegated to the parent through onSubmit, so this component stays purely
 * about interaction.
 */
export function AddWorkspaceDirectory({
  onSubmit,
  onCancel,
}: AddWorkspaceDirectoryProps): React.JSX.Element {
  const [validatedPath, setValidatedPath] = useState<string | null>(null);

  // Esc handling for the trust-choice step. The path-input step uses
  // DirectoryPathInput's built-in onCancel.
  const handleTrustKey = useCallback(
    (key: Key) => {
      if (validatedPath && key.name === 'escape') {
        onCancel();
        return true;
      }
      return false;
    },
    [validatedPath, onCancel],
  );
  useKeypress(handleTrustKey, { isActive: validatedPath !== null });

  const trustOptions: Array<RadioSelectItem<AddDirTrustChoice>> = useMemo(
    () => [
      {
        label: 'Trust (this session only)',
        value: 'memory',
        key: 'memory',
        sublabel: 'Add to workspace context in memory only — not saved to disk.',
      },
      {
        label: 'Trust (remember across sessions)',
        value: 'persist',
        key: 'persist',
        sublabel:
          'Add to workspace context and save to settings.local.json so it is remembered across sessions.',
      },
    ],
    [],
  );

  // Step 1: path input
  if (!validatedPath) {
    return (
      <DirectoryPathInput
        title="Add directory to workspace"
        description={
          <Text>
            Enter an absolute path, a path relative to the current working
            directory, or one starting with <Text bold>~</Text>.
          </Text>
        }
        onSubmit={(resolvedPath) => setValidatedPath(resolvedPath)}
        onCancel={onCancel}
      />
    );
  }

  // Step 2: choose trust level
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold color={theme.ui.active}>
        How do you want to trust this directory?
      </Text>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{validatedPath}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={trustOptions}
          onSelect={(choice) => onSubmit(validatedPath, choice)}
          isFocused={true}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
