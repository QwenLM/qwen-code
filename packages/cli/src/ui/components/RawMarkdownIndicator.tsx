/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { Command } from '../key/keyBindings.js';
import { useI18nService } from '../i18n/index.js';

export const RawMarkdownIndicator: React.FC = () => {
  const i18n = useI18nService();
  const modKey = formatCommand(Command.TOGGLE_MARKDOWN);
  return (
    <Box>
      <Text>
        {i18n.get('status.rawMarkdownMode')}
        <Text color={theme.text.secondary}>
          {i18n.get('status.rawMarkdownToggle', { shortcut: modKey })}
        </Text>
      </Text>
    </Box>
  );
};
