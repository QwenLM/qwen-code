/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { resolveMainSessionOutputStyle } from '@qwen-code/qwen-code-core';
import {
  applyOutputStyleSelection,
  formatOutputStyleNames,
  loadSessionOutputStyles,
  OUTPUT_STYLE_LIST,
  resolveOutputStyleChoice,
} from './output-style-utils.js';

export const outputStyleCommand: SlashCommand = {
  name: 'output-style',
  get description() {
    return t(
      'Choose the output style that shapes how responses are written ({{styles}}).',
      { styles: OUTPUT_STYLE_LIST },
    );
  },
  // Styles show up as a placeholder rather than as autocompletion suggestions
  // for the same reason as /effort: bare `/output-style` should open the
  // picker with nothing auto-selected.
  argumentHint: '[Concise|Proactive|Explanatory|Learning|<custom>|default]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    actionArgs: string,
  ): Promise<MessageActionReturn | OpenDialogActionReturn> => {
    const { services } = context;
    const { config, settings } = services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    if (config.getBareMode() || config.isSafeMode()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Output styles are unavailable in --bare and --safe-mode.'),
      };
    }

    const args = context.invocation?.args?.trim() || actionArgs.trim();

    // No argument: open the interactive picker, or (non-interactive/ACP)
    // report the current style and the available options.
    if (!args && context.executionMode === 'interactive') {
      return { type: 'dialog', dialog: 'output-style' };
    }

    const available = await loadSessionOutputStyles(config);
    const styles = formatOutputStyleNames(available);

    if (!args) {
      const current = resolveMainSessionOutputStyle(config);
      return {
        type: 'message',
        messageType: 'info',
        content: current
          ? t(
              'Current output style: {{current}}\nAvailable: {{styles}}, default\nUse "/output-style <name>" to change it.',
              { current: current.name, styles },
            )
          : t(
              'Output style: default.\nAvailable: {{styles}}\nUse "/output-style <name>" to set one.',
              { styles },
            ),
      };
    }

    const style = resolveOutputStyleChoice(args, available);
    if (style === null) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Unknown output style "{{value}}". Choose one of: {{styles}}, or "default" for no style.',
          { value: args, styles },
        ),
      };
    }

    if (!settings) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Settings service not available.'),
      };
    }

    try {
      return {
        type: 'message',
        messageType: 'info',
        content: await applyOutputStyleSelection(config, settings, style, {
          allowWorkspaceSettingsWrite:
            context.executionPolicy?.allowWorkspaceSettingsWrite,
        }),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to set "{{key}}": {{error}}', {
          key: 'general.outputStyle',
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
