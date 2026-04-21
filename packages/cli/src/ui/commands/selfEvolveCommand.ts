/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SelfEvolveService } from '../../services/SelfEvolveService.js';

function formatResult(
  result: Awaited<ReturnType<SelfEvolveService['run']>>,
): string {
  const lines: string[] = [result.summary];
  if (result.selectedTask) {
    lines.push(`Task: ${result.selectedTask}`);
  }
  if (result.ok) {
    lines.push(`Branch: ${result.branch}`);
    lines.push(`Commit: ${result.commitSha}`);
  }
  if (result.validation && result.validation.length > 0) {
    lines.push(`Validation: ${result.validation.join(' | ')}`);
  }
  if (!result.ok && result.learnings.length > 0) {
    lines.push(`Learnings: ${result.learnings.join(' | ')}`);
  }
  lines.push(`Record: ${result.recordPath}`);
  return lines.join('\n');
}

export const selfEvolveCommand: SlashCommand = {
  name: 'self-evolve',
  description:
    'Attempt one small safe repo improvement in an isolated worktree',
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args): Promise<void | MessageActionReturn> => {
    if (args.trim()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /self-evolve'),
      };
    }

    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration is not available.'),
      };
    }

    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode === 'interactive') {
      context.ui.setPendingItem({
        type: 'info',
        text: t('Running self-evolve in an isolated worktree...'),
      });
    }

    try {
      const service = new SelfEvolveService();
      const result = await service.run(config);
      const content = formatResult(result);
      if (executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: result.ok ? 'info' : 'error',
            text: content,
          },
          Date.now(),
        );
        return;
      }

      return {
        type: 'message',
        messageType: result.ok ? 'info' : 'error',
        content,
      };
    } finally {
      if (executionMode === 'interactive') {
        context.ui.setPendingItem(null);
      }
    }
  },
};
