/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { CliSpinner } from './CliSpinner.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';

/**
 * Renders the auto-update progress indicator (updating / success / failed) in
 * the single-line status display shared with the context-summary marquee.
 */
export const UpdateStatusBar = () => {
  const { updateInfo } = useUIState();
  const status = updateInfo?.status;

  if (!status) return null;

  return (
    <Box
      height={1}
      paddingX={1}
      overflow="hidden"
    >
      {status === 'updating' && (
        <Text color={theme.text.secondary} wrap="truncate-end">
          <CliSpinner /> Updating from {updateInfo?.update?.current} to{' '}
          {updateInfo?.update?.latest}
        </Text>
      )}
      {status === 'success' && (
        <Text color={theme.status.success} wrap="truncate-end">
          ✓{' '}
          {updateInfo?.message ||
            `${updateInfo?.update?.latest} updated successfully, restart to take effect`}
        </Text>
      )}
      {status === 'failed' && (
        <Text color={theme.status.error} wrap="truncate-end">
          ✗ {updateInfo?.message || `${updateInfo?.update?.latest} update failed`}
        </Text>
      )}
    </Box>
  );
};
