/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

/**
 * Resolve the current effective verbose preference from settings. The
 * legacy `ui.compactMode` setting still wins when present so users who
 * customised it before the rewrite are not surprised.
 */
function currentVerbose(context: CommandContext): boolean {
  const envVerbose = process.env['QWEN_CODE_VERBOSE'];
  if (envVerbose === '1') return true;
  if (envVerbose === '0') return false;
  const ui = context.services.settings?.merged?.ui;
  if (typeof ui?.verbose === 'boolean') return ui.verbose;
  if (typeof ui?.compactMode === 'boolean') return !ui.compactMode;
  return false;
}

async function applyVerbose(
  context: CommandContext,
  value: boolean,
): Promise<MessageActionReturn> {
  const settings = context.services.settings;
  if (!settings?.setValue) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }
  // SettingScope.User keeps workspace-level overrides intact. AppContainer
  // has an effect that subscribes to `settings.merged.ui.verbose` so the
  // running session reflects the change without a restart.
  await settings.setValue(SettingScope.User, 'ui.verbose', value);
  return {
    type: 'message',
    messageType: 'info',
    content: value ? t('ui.verbose.enabled') : t('ui.verbose.disabled'),
  };
}

export const verboseCommand: SlashCommand = {
  name: 'verbose',
  get description() {
    return t('ui.verbose.description');
  },
  argumentHint: '[on|off|toggle]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,

  action: async (context, args) => {
    const trimmed = (args ?? '').trim().toLowerCase();
    const current = currentVerbose(context);

    if (!trimmed) {
      return {
        type: 'message',
        messageType: 'info',
        content: current ? t('ui.verbose.statusOn') : t('ui.verbose.statusOff'),
      };
    }

    if (trimmed === 'on' || trimmed === 'true' || trimmed === '1') {
      return applyVerbose(context, true);
    }
    if (trimmed === 'off' || trimmed === 'false' || trimmed === '0') {
      return applyVerbose(context, false);
    }
    if (trimmed === 'toggle') {
      return applyVerbose(context, !current);
    }
    return {
      type: 'message',
      messageType: 'error',
      content: t('ui.verbose.usage'),
    };
  },
};
