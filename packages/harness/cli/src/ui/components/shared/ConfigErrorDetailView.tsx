/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { BaseTabDialog } from './BaseTabDialog.js';
import type { ConfigLoadError } from '@qwen-code/core';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConfigErrorDetailViewProps {
  error: ConfigLoadError;
  /** Human-readable label: "agent" | "skill" | "hook" */
  configLabel: string;
  onClose: () => void;
}

// ─── Main Component ────────────────────────────────────────────────────────

/**
 * A lightweight detail view that displays full error information for a
 * broken config item (agent, skill, or hook) that failed to load.
 */
export function ConfigErrorDetailView({
  error,
  configLabel,
  onClose,
}: ConfigErrorDetailViewProps): React.JSX.Element {
  // Keyboard: Esc-to-close is handled by BaseTabDialog's onClose prop
  // via the Dialog context action handler (dialog:escape → Command.ESCAPE).

  const displayName =
    error.name || configLabel.charAt(0).toUpperCase() + configLabel.slice(1);
  const title = `${configLabel.charAt(0).toUpperCase() + configLabel.slice(1)}s > ${displayName} > Load Error`;

  return (
    <BaseTabDialog title={title} onClose={onClose}>
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {/* Name */}
        {error.name && (
          <Box flexDirection="row">
            <Text color={theme.text.secondary} bold>
              Name:{' '}
            </Text>
            <Text color={theme.text.primary}>{error.name}</Text>
          </Box>
        )}

        {/* File Path */}
        <Box flexDirection="row">
          <Text color={theme.text.secondary} bold>
            File:{' '}
          </Text>
          <Text color={theme.text.primary}>{error.filePath}</Text>
        </Box>

        {/* Source */}
        {error.source && (
          <Box flexDirection="row">
            <Text color={theme.text.secondary} bold>
              Source:{' '}
            </Text>
            <Text color={theme.text.primary}>{error.source}</Text>
          </Box>
        )}

        {/* Config Type */}
        <Box flexDirection="row">
          <Text color={theme.text.secondary} bold>
            Type:{' '}
          </Text>
          <Text color={theme.text.primary}>{error.configType}</Text>
        </Box>

        {/* Error Message (full, wrapped) */}
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.warning} bold>
            Error:
          </Text>
          <Box paddingLeft={1}>
            <Text color={theme.status.warning} wrap="wrap">
              {error.message}
            </Text>
          </Box>
        </Box>
      </Box>
    </BaseTabDialog>
  );
}
