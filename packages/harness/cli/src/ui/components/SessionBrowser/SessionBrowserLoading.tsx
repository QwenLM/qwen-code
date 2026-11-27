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
 * Loading state component displayed while sessions are being loaded.
 */
export const SessionBrowserLoading = (): React.JSX.Element => {
  const i18n = useI18nService();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={Colors.Gray}>{i18n.get('session.loading')}</Text>
    </Box>
  );
};
