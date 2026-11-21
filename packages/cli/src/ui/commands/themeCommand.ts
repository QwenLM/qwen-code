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
import type { LoadedSettings } from '../../config/settings.js';
import { AUTO_THEME_NAME, themeManager } from '../themes/theme-manager.js';

/** Every theme name `/theme <name>` accepts: built-in, custom, and `auto`. */
function getSelectableThemeNames(settings: LoadedSettings): string[] {
  const customThemes = {
    ...(settings.user.settings.ui?.customThemes || {}),
    ...(settings.workspace.settings.ui?.customThemes || {}),
  };
  const names = [
    AUTO_THEME_NAME,
    ...themeManager.getAvailableThemes().map((theme) => theme.name),
    ...Object.keys(customThemes),
  ];
  return [...new Set(names)];
}

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

  const available = getSelectableThemeNames(settings);
  const themeName = available.find(
    (name) => name.toLowerCase() === requested.toLowerCase(),
  );
  if (!themeName) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Unknown theme "{{value}}". Choose one of: {{themes}}.', {
        value: requested,
        themes: available.join(', '),
      }),
    };
  }

  // Save where it takes effect: a workspace theme would override a user one.
  const scope =
    settings.workspace.settings.ui?.theme !== undefined
      ? SettingScope.Workspace
      : SettingScope.User;
  settings.setValue(scope, 'ui.theme', themeName);
  if (settings.merged.ui?.customThemes) {
    themeManager.loadCustomThemes(settings.merged.ui.customThemes);
  }
  themeManager.setActiveTheme(settings.merged.ui?.theme ?? AUTO_THEME_NAME);
  context.ui.onThemeChanged?.();

  return {
    type: 'message',
    messageType: 'info',
    content: t('Theme set to {{themeName}}.', { themeName }),
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
