/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

const startupTips = [
  'Use /compress when the conversation gets long to summarize history and free up context.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.',
  'Use /bug to submit issues to the maintainers when something goes off.',
  'Switch auth type quickly with /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
] as const;

export const Tips: React.FC = () => {
  const selectedTip = useMemo(() => {
    const randomIndex = Math.floor(Math.random() * startupTips.length);
    return startupTips[randomIndex];
  }, []);

  return (
    <Box marginLeft={2} marginRight={2}>
      <Text color={theme.text.secondary}>
        {t('Tips: ')}
        {t(selectedTip)}
      </Text>
    </Box>
  );
};
