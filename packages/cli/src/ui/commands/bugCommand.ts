/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import open from 'open';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType, type HistoryItem } from '../types.js';
import { getExtendedSystemInfo } from '../../utils/systemInfo.js';
import { getSystemInfoFields } from '../../utils/systemInfoFields.js';
import { t } from '../../i18n/index.js';

export const bugCommand: SlashCommand = {
  name: 'bug',
  get description() {
    return t('submit a bug report');
  },
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    const bugDescription = (args || '').trim();
    const systemInfo = await getExtendedSystemInfo(context);

    const fields = getSystemInfoFields(systemInfo);

    const info = fields
      .map((field) => `${field.label}: ${field.value}`)
      .join('\n');

    let bugReportUrl =
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title={title}&info={info}';

    const bugCommandSettings = context.services.config?.getBugCommand();
    if (bugCommandSettings?.urlTemplate) {
      bugReportUrl = bugCommandSettings.urlTemplate;
    }

    bugReportUrl = bugReportUrl
      .replace('{title}', encodeURIComponent(bugDescription))
      .replace('{info}', encodeURIComponent(`\n${info}\n`));

    const bugReportItem: Omit<Extract<HistoryItem, { type: 'info' }>, 'id'> = {
      type: MessageType.INFO,
      text: 'To submit your bug report, please open the following URL in your browser:',
      linkUrl: bugReportUrl,
      linkText: 'Open GitHub bug report form',
    };

    context.ui.addItem(bugReportItem, Date.now());

    try {
      await open(bugReportUrl);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Could not open URL in browser: ${errorMessage}`,
        },
        Date.now(),
      );
    }
  },
};
