/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

type Tip = string | { text: string; weight: number };

const startupTips: Tip[] = [
  'Use /compress when the conversation gets long to summarize history and free up context.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.',
  'Use /bug to submit issues to the maintainers when something goes off.',
  'Switch auth type quickly with /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.',
  process.platform === 'win32'
    ? 'You can switch permission mode quickly with Tab or /approval-mode.'
    : 'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
  {
    text: 'Try /insight to generate personalized insights from your chat history.',
    weight: 3,
  },
];

function tipText(tip: Tip): string {
  return typeof tip === 'string' ? tip : tip.text;
}

function tipWeight(tip: Tip): number {
  return typeof tip === 'string' ? 1 : tip.weight;
}

export function selectWeightedTip(tips: Tip[]): string {
  const totalWeight = tips.reduce((sum, tip) => sum + tipWeight(tip), 0);
  let random = Math.random() * totalWeight;
  for (const tip of tips) {
    random -= tipWeight(tip);
    if (random <= 0) {
      return tipText(tip);
    }
  }
  return tipText(tips[tips.length - 1]!);
}

export const Tips: React.FC = () => {
  const selectedTip = useMemo(() => selectWeightedTip(startupTips), []);

  return (
    <Box marginLeft={2} marginRight={2}>
      <Text color={theme.text.secondary}>
        {t('Tips: ')}
        {t(selectedTip)}
      </Text>
    </Box>
  );
};
