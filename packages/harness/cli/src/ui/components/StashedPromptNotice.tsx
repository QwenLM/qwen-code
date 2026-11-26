/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';

export interface StashedPromptNoticeProps {
  hasStash: boolean;
}

/**
 * Reminder that a draft is parked in the ctrl+s stash. Visibility tracks the
 * stash itself, so the notice is present exactly while an auto-restore is still
 * possible.
 */
export const StashedPromptNotice: React.FC<StashedPromptNoticeProps> = ({
  hasStash,
}) => {
  if (!hasStash) {
    return null;
  }

  return (
    <Box paddingLeft={2}>
      <Text dimColor>Stashed (restores after submit)</Text>
    </Box>
  );
};
