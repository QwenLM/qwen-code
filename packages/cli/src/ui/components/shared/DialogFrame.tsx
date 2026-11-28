/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { Box, useIsScreenReaderEnabled } from 'ink';
import { theme } from '../../semantic-colors.js';
import { getDialogSurfaceColor } from '../../utils/theme-background.js';

export function DialogFrame({
  children,
  paddingY = 1,
}: {
  children: ReactNode;
  paddingY?: number;
}) {
  const screenReader = useIsScreenReaderEnabled();
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      backgroundColor={screenReader ? undefined : getDialogSurfaceColor()}
      flexDirection="column"
      paddingX={1}
      paddingY={paddingY}
      width="100%"
    >
      {children}
    </Box>
  );
}
