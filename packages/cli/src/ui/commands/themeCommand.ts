/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type {
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';
import {
  applyThemeSetting,
  resolveThemeName,
} from '../themes/theme-selection.js';

function setThemeByName(
  context: CommandContext,
  requested: string,
): MessageActionReturn {
  const { settings } = context.services;
  if (!settings) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Settings service not available.'),
    };
  }

  const resolution = resolveThemeName(settings, requested);
  if (resolution.kind === 'pinned-by-system') {
    return {
      type: 'message',
      messageType: 'error',
      content: t(
        'The theme is set in system settings, so /theme cannot change it.',
      ),
    };
  }
  if (resolution.kind === 'unknown') {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Unknown theme "{{value}}". Choose one of: {{themes}}.', {
        value: requested,
        themes: resolution.available.join(', '),
      }),
    };
  }

  const { name: themeName, scope } = resolution;
  const { effective, applied } = applyThemeSetting(settings, scope, themeName);
  if (!applied || effective !== themeName) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Theme "{{themeName}}" could not be applied.', { themeName }),
    };
  }
  context.ui.onThemeChanged?.();

  return {
    type: 'message',
    messageType: 'info',
    content:
      scope === SettingScope.Workspace
        ? t('Theme set to {{themeName}} (project settings).', { themeName })
        : t('Theme set to {{themeName}} (user settings).', { themeName }),
  };
}

export const themeCommand: SlashCommand = {
  name: 'theme',
  get description() {
    return t('change the theme');
  },
  // Like /effort: the names show as a placeholder rather than completions, so
  // bare `/theme` opens the picker instead of auto-selecting the first name.
  argumentHint: '[name]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  canRunDuringStreaming: true,
  action: (context, args): OpenDialogActionReturn | MessageActionReturn => {
    // Reject before opening the dialog: with NO_COLOR the theme picker
    // cannot run, and returning a message lets the processor record the
    // feedback after the invocation record instead of before it.
    if (process.env['NO_COLOR']) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Theme configuration unavailable due to NO_COLOR env variable.',
        ),
      };
    }
    const requested = args.trim();
    if (requested) {
      return setThemeByName(context, requested);
    }
    return {
      type: 'dialog',
      dialog: 'theme',
    };
  },
};
