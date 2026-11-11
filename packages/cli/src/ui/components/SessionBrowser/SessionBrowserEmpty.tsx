/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import { useI18nService } from '../../i18n/index.js';

/**
 * Empty state component displayed when no sessions are found.
 */
export const SessionBrowserEmpty = ({
  canShowAllWorktrees = false,
}: {
  canShowAllWorktrees?: boolean;
}): React.JSX.Element => {
  const i18n = useI18nService();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={Colors.Gray}>
        {i18n.get(
          canShowAllWorktrees
            ? 'session.empty.currentWorktree'
            : 'session.empty.all',
        )}
      </Text>
      {!canShowAllWorktrees && (
        <Text color={Colors.Gray}>{i18n.get('session.hint.exit')}</Text>
      )}
    </Box>
  );
};
