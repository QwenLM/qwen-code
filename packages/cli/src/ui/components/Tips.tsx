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
  // 'Use /compress when the conversation gets long to summarize history and free up context.',
  // 'Start a fresh idea with /clear or /new; the previous session stays available in history.',
  // 'Use /bug to submit issues to the maintainers when something goes off.',
  // 'Switch auth type quickly with /auth.',
  // 'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
  // 'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.',
  // 'You can resume a previous conversation by running qwen --continue or qwen --resume.',
  // process.platform === 'win32'
  //   ? 'You can switch permission mode quickly with Tab or /approval-mode.'
  //   : 'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
  // {
  //   text: 'Try /insight to generate personalized insights from your chat history.',
  //   weight: 3,
  // },
  // DataWorks usage examples
  {
    text: '👤 Identity: "Help me verify my identity and permissions in DataWorks?"',
    weight: 2,
  },
  {
    text: '📊 Analysis: "Analyze the newly created nodes in the dataworks_analyze workspace in the past week and what they are doing?"',
    weight: 2,
  },
  {
    text: '🧹 Governance: "In the dataworks_analyze workspace, help me find nodes that were created long ago but have never been published."',
    weight: 2,
  },
  {
    text: '🔍 Troubleshooting: "The data in dwd_is_it_software_released_df and ads_is_it_sfw_moni_key_released_recycled_df are inconsistent, both have upstream ods_ism_it_software_key_released_df. Help me check what is different in their logic?"',
    weight: 2,
  },
  {
    text: '🛠️ Fix: "In the employee table my_project.ods_emp_info_d, the department data for employee EMP001 is empty. Help me troubleshoot the cause and provide fix suggestions."',
    weight: 2,
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
    <Box flexDirection="column" marginLeft={2} marginRight={2}>
      <Text color={theme.text.secondary}>
        {t('Example: ')}
        {t(selectedTip)}
      </Text>
      <Text> </Text>
      <Text color={theme.text.secondary}>
        {t(
          'This is a Beta version. Chat history will be lost after the personal development environment instance is deleted.',
        )}
      </Text>
    </Box>
  );
};
