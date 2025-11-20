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
import { MessageType } from '../types.js';
import { getExtendedSystemInfo } from '../../utils/systemInfo.js';
import {
  getSystemInfoFields,
  getFieldValue,
} from '../../utils/systemInfoFields.js';

export const bugCommand: SlashCommand = {
  name: 'bug',
  description: 'submit a bug report',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    const bugDescription = (args || '').trim();
    const systemInfo = await getExtendedSystemInfo(context);

    const fields = getSystemInfoFields(systemInfo);

    // Generate bug report info using the same field configuration
    let info = '\n';
    for (const field of fields) {
      info += `* **${field.label}:** ${getFieldValue(field, systemInfo)}\n`;
    }

    let bugReportUrl =
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title={title}&info={info}';

    const bugCommandSettings = context.services.config?.getBugCommand();
    if (bugCommandSettings?.urlTemplate) {
      bugReportUrl = bugCommandSettings.urlTemplate;
    }

    bugReportUrl = bugReportUrl
      .replace('{title}', encodeURIComponent(bugDescription))
      .replace('{info}', encodeURIComponent(info));

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `To submit your bug report, please open the following URL in your browser:\n${bugReportUrl}`,
      },
      Date.now(),
    );

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
