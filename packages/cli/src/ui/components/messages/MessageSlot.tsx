/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import {
  type SpacingCategory,
  getSpacingGap,
} from '../../constants/messageLayout.js';

export interface MessageSlotProps {
  /** The spacing category of this message (defaults to 'system-notice') */
  category?: SpacingCategory;
  /** The spacing category of the previous message (undefined if first) */
  prevCategory?: SpacingCategory;
  /** Terminal width for the outer Box */
  terminalWidth: number;
  children: React.ReactNode;
}

/**
 * MessageSlot — the single source of truth for inter-message spacing.
 *
 * Every message rendered in HistoryItemDisplay is wrapped by MessageSlot.
 * Message components themselves must NOT set external margin (M1 rule).
 * All spacing decisions are made here via getSpacingGap().
 */
export const MessageSlot: React.FC<MessageSlotProps> = ({
  category,
  prevCategory,
  terminalWidth,
  children,
}) => {
  const effectiveCategory = category ?? 'system-notice';
  const gap = getSpacingGap(prevCategory, effectiveCategory);

  return (
    <Box flexDirection="column" width={terminalWidth} marginTop={gap}>
      {children}
    </Box>
  );
};
