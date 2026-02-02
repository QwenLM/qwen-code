/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import {
  setLanguageAsync,
  getCurrentLanguage,
  type SupportedLanguage,
  t,
} from '../../i18n/index.js';
import {
  SUPPORTED_LANGUAGES,
  getSupportedLanguageIds,
} from '../../i18n/languages.js';
import {
  OUTPUT_LANGUAGE_AUTO,
  isAutoLanguage,
  resolveOutputLanguage,
  updateOutputLanguageFile,
} from '../../utils/languageUtils.js';

/**
 * Gets the current LLM output language setting and its resolved value.
 * Returns an object with both the raw setting and the resolved language.
 */
function getCurrentOutputLanguage(context?: CommandContext): {
  setting: string;
  resolved: string;
} {
  const settingValue =
    context?.services?.settings?.merged?.general?.outputLanguage ||
    OUTPUT_LANGUAGE_AUTO;
  const resolved = resolveOutputLanguage(settingValue);
  return { setting: settingValue, resolved };
}

/**
 * Parses user input to find a matching supported UI language.
 * Accepts locale codes (e.g., "zh"), IDs (e.g., "zh-CN"), or full names (e.g., "Chinese").
 */
function parseUiLanguageArg(input: string): SupportedLanguage | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;

  for (const lang of SUPPORTED_LANGUAGES) {
    if (
      lowered === lang.code ||
      lowered === lang.id.toLowerCase() ||
      lowered === lang.fullName.toLowerCase()
    ) {
      return lang.code;
    }
  }
  return null;
}

/**
 * Formats a UI language code for display (e.g., "zh" -> "中文 (Chinese) [zh-CN]").
 */
function formatUiLanguageDisplay(lang: SupportedLanguage): string {
  const option = SUPPORTED_LANGUAGES.find((o) => o.code === lang);
  if (!option) return lang;
  return option.nativeName && option.nativeName !== option.fullName
    ? `${option.nativeName} (${option.fullName}) [${option.id}]`
    : `${option.fullName} [${option.id}]`;
}

/**
 * Sets the UI language and persists it to user settings.
 */
async function setUiLanguage(
  context: CommandContext,
  lang: SupportedLanguage,
): Promise<MessageActionReturn> {
  const { services } = context;

  if (!services.config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }

  // Update i18n system
  await setLanguageAsync(lang);

  // Persist to settings
  if (services.settings?.setValue) {
    try {
      services.settings.setValue(SettingScope.User, 'general.language', lang);
    } catch (error) {
      console.warn('Failed to save language setting:', error);
    }
  }

  // Reload commands to update localized descriptions
  context.ui.reloadCommands();

  return {
    type: 'message',
    messageType: 'info',
    content: t('UI language changed to {{lang}}', {
      lang: formatUiLanguageDisplay(lang),
    }),
  };
}

/**
 * Handles the /language output command, updating both the setting and the rule file.
 * 'auto' is preserved in settings but resolved to the detected language for the rule file.
 */
async function setOutputLanguage(
  context: CommandContext,
  language: string,
): Promise<MessageActionReturn> {
  try {
    const isAuto = isAutoLanguage(language);
    const resolved = resolveOutputLanguage(language);
    // Save 'auto' as-is to settings, or normalize other values
    const settingValue = isAuto ? OUTPUT_LANGUAGE_AUTO : resolved;

    // Update the rule file with the resolved language
    updateOutputLanguageFile(settingValue);

    // Save to settings
    if (context.services.settings?.setValue) {
      try {
        context.services.settings.setValue(
          SettingScope.User,
          'general.outputLanguage',
          settingValue,
        );
      } catch (error) {
        console.warn('Failed to save output language setting:', error);
      }
    }

    // Format display message
    const displayLang = isAuto
      ? `${t('Auto (detect from system)')} → ${resolved}`
      : resolved;

    return {
      type: 'message',
      messageType: 'info',
      content: [
        t('LLM output language set to {{lang}}', { lang: displayLang }),
        '',
        t('Please restart the application for the changes to take effect.'),
      ].join('\n'),
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: t(
        'Failed to generate LLM output language rule file: {{error}}',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }
}

export const languageCommand: SlashCommand = {
  name: 'language',
  get description() {
    return t('View or change the language setting');
  },
  kind: CommandKind.BUILT_IN,

  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    if (!context.services.config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    const trimmedArgs = args.trim();

    // Route to subcommands if specified
    if (trimmedArgs) {
      const [firstArg, ...rest] = trimmedArgs.split(/\s+/);
      const subCommandName = firstArg.toLowerCase();
      const subArgs = rest.join(' ');

      if (subCommandName === 'ui' || subCommandName === 'output') {
        const subCommand = languageCommand.subCommands?.find(
          (s) => s.name === subCommandName,
        );
        if (subCommand?.action) {
          return subCommand.action(
            context,
            subArgs,
          ) as Promise<SlashCommandActionReturn>;
        }
      }

      // Backward compatibility: direct language code (e.g., /language zh)
      const targetLang = parseUiLanguageArg(trimmedArgs);
      if (targetLang) {
        return setUiLanguage(context, targetLang);
      }

      // Unknown argument
      return {
        type: 'message',
        messageType: 'error',
        content: [
          t('Invalid command. Available subcommands:'),
          `  - /language ui [${getSupportedLanguageIds()}] - ${t('Set UI language')}`,
          `  - /language output <language> - ${t('Set LLM output language')}`,
        ].join('\n'),
      };
    }

    // No arguments: show current status
    const currentUiLang = getCurrentLanguage();
    const { setting: outputSetting, resolved: outputResolved } =
      getCurrentOutputLanguage(context);

    // Format output language display: show "Auto → English" or just "English"
    const outputLangDisplay = isAutoLanguage(outputSetting)
      ? `${t('Auto (detect from system)')} → ${outputResolved}`
      : outputResolved;

    return {
      type: 'message',
      messageType: 'info',
      content: [
        t('Current UI language: {{lang}}', {
          lang: formatUiLanguageDisplay(currentUiLang as SupportedLanguage),
        }),
        t('Current LLM output language: {{lang}}', { lang: outputLangDisplay }),
        '',
        t('Available subcommands:'),
        `  /language ui [${getSupportedLanguageIds()}] - ${t('Set UI language')}`,
        `  /language output <language> - ${t('Set LLM output language')}`,
      ].join('\n'),
    };
  },

  subCommands: [
    // /language ui subcommand
    {
      name: 'ui',
      get description() {
        return t('Set UI language');
      },
      kind: CommandKind.BUILT_IN,

      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn> => {
        const trimmedArgs = args.trim();

        if (!trimmedArgs) {
          return {
            type: 'message',
            messageType: 'info',
            content: [
              t('Set UI language'),
              '',
              t('Usage: /language ui [{{options}}]', {
                options: getSupportedLanguageIds(),
              }),
              '',
              t('Available options:'),
              ...SUPPORTED_LANGUAGES.map(
                (o) => `  - ${o.id}: ${o.nativeName || o.fullName}`,
              ),
              '',
              t(
                'To request additional UI language packs, please open an issue on GitHub.',
              ),
            ].join('\n'),
          };
        }

        const targetLang = parseUiLanguageArg(trimmedArgs);
        if (!targetLang) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Invalid language. Available: {{options}}', {
              options: getSupportedLanguageIds(','),
            }),
          };
        }

        return setUiLanguage(context, targetLang);
      },

      // Nested subcommands for each supported language (e.g., /language ui zh-CN)
      subCommands: SUPPORTED_LANGUAGES.map(
        (lang): SlashCommand => ({
          name: lang.id,
          get description() {
            return t('Set UI language to {{name}}', {
              name: lang.nativeName || lang.fullName,
            });
          },
          kind: CommandKind.BUILT_IN,
          action: async (context, args) => {
            if (args.trim()) {
              return {
                type: 'message',
                messageType: 'error',
                content: t(
                  'Language subcommands do not accept additional arguments.',
                ),
              };
            }
            return setUiLanguage(context, lang.code);
          },
        }),
      ),
    },

    // /language output subcommand
    {
      name: 'output',
      get description() {
        return t('Set LLM output language');
      },
      kind: CommandKind.BUILT_IN,

      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn> => {
        const trimmedArgs = args.trim();

        if (!trimmedArgs) {
          return {
            type: 'message',
            messageType: 'info',
            content: [
              t('Set LLM output language'),
              '',
              t('Usage: /language output <language>'),
              `  ${t('Example: /language output 中文')}`,
              `  ${t('Example: /language output English')}`,
              `  ${t('Example: /language output 日本語')}`,
            ].join('\n'),
          };
        }

        return setOutputLanguage(context, trimmedArgs);
      },
    },
  ],
};
