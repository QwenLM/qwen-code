/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import type { CliWelcomeHeaderProps } from './WelcomeHeaderProps.js';

export function DefaultWelcomeHeader({
  cliDisplayName,
  versionLabel,
}: CliWelcomeHeaderProps) {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
      <Box>
        <Text bold color={theme.text.primary}>
          {cliDisplayName}
        </Text>
        <Text color={theme.text.secondary}> {versionLabel}</Text>
      </Box>
    </Box>
  );
}
