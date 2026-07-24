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
  resolveSupportedLanguage,
  SUPPORTED_LANGUAGES,
  getSupportedLanguageIds,
} from '../../i18n/languages.js';
import {
  OUTPUT_LANGUAGE_AUTO,
  isAutoLanguage,
  resolveOutputLanguageOrPreserveAuto,
  writeOutputLanguageAndRegisterPath,
} from '../../utils/languageUtils.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('LANGUAGE_COMMAND');

/**
 * Gets the current LLM output language setting and its display value.
 * Returns an object with both the raw setting and the display language.
 */
function getCurrentOutputLanguage(context?: CommandContext): {
  setting: string;
  resolved: string;
} {
  const settingValue =
    context?.services?.settings?.merged?.general?.outputLanguage ||
    OUTPUT_LANGUAGE_AUTO;
  const resolved = resolveOutputLanguageOrPreserveAuto(settingValue);
  return { setting: settingValue, resolved };
}

/**
 * Parses user input to find a matching supported UI language.
 * Accepts locale codes (e.g., "zh"), IDs (e.g., "zh-CN"), or full names (e.g., "Chinese").
 */
function parseUiLanguageArg(input: string): SupportedLanguage | null {
  return resolveSupportedLanguage(input) ?? null;
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
 * Parses `--project` / `--global` scope flags from a UI-language argument
 * string, returning the resolved scope and the argument with the flags removed.
 * Mirrors the scope handling in `modelCommand` so UI-language edits can target
 * workspace or user settings (e.g. from the web-shell settings panel's
 * Workspace/User tab) instead of always writing user scope.
 */
function parseUiScopeFlags(input: string): {
  scope: SettingScope | undefined;
  remaining: string;
  hasProject: boolean;
  hasGlobal: boolean;
} {
  let remaining = input;
  const hasProject = /(?:^|\s)--project(?:\s|$)/.test(remaining);
  const hasGlobal = /(?:^|\s)--global(?:\s|$)/.test(remaining);
  let scope: SettingScope | undefined;
  if (hasProject) {
    scope = SettingScope.Workspace;
    remaining = remaining.replace(/(?:^|\s)--project(?:\s|$)/, ' ').trim();
  }
  if (hasGlobal) {
    scope = SettingScope.User;
    remaining = remaining.replace(/(?:^|\s)--global(?:\s|$)/, ' ').trim();
  }
  return { scope, remaining, hasProject, hasGlobal };
}

/**
 * Sets the UI language and persists it to the given scope (user settings by
 * default).
 */
async function setUiLanguage(
  context: CommandContext,
  lang: SupportedLanguage,
  scope: SettingScope = SettingScope.User,
): Promise<MessageActionReturn> {
  const { services } = context;

  if (!services.config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }

  await setLanguageAsync(lang);

  if (services.settings?.setValue) {
    try {
      services.settings.setValue(scope, 'general.language', lang);
    } catch (error) {
      debugLogger.warn('Failed to save language setting:', error);
    }
  }

  // Reload commands so `t()` lookups in their metadata re-resolve under the new language.
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
 * 'auto' is preserved in settings and written as a dynamic same-language rule.
 *
 * After persisting the change, hierarchical memory is reloaded so
 * `output-language.md` flows back into `userMemory`, then the live chat queues
 * refreshed session context. The new language therefore takes effect on the
 * next turn without restarting the session or losing conversation history.
 */
async function setOutputLanguage(
  context: CommandContext,
  language: string,
): Promise<MessageActionReturn> {
  try {
    const isAuto = isAutoLanguage(language);
    const resolved = resolveOutputLanguageOrPreserveAuto(language);
    // Save 'auto' as-is to settings, or normalize other values
    const settingValue = isAuto ? OUTPUT_LANGUAGE_AUTO : resolved;

    writeOutputLanguageAndRegisterPath(settingValue, context.services.config);

    if (context.services.settings?.setValue) {
      try {
        context.services.settings.setValue(
          SettingScope.User,
          'general.outputLanguage',
          settingValue,
        );
      } catch (error) {
        debugLogger.warn('Failed to save output language setting:', error);
      }
    }

    // Apply the new rule to the running session: refresh hierarchical memory
    // so output-language.md is re-read into userMemory, then queue refreshed
    // session context on the live chat.
    const config = context.services.config;
    if (config) {
      try {
        await config.refreshHierarchicalMemory();
        await config.getGeminiClient().refreshSystemInstruction();
      } catch (error) {
        debugLogger.warn(
          'Failed to apply output language to running session:',
          error,
        );
      }
    }

    const displayLang = isAuto ? t('Auto (follow user input)') : resolved;

    return {
      type: 'message',
      messageType: 'info',
      content: t('LLM output language set to {{lang}}', { lang: displayLang }),
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
  argumentHint: 'ui|output <language>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,

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

    // Format output language display: show auto mode or the fixed language.
    const outputLangDisplay = isAutoLanguage(outputSetting)
      ? t('Auto (follow user input)')
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
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,

      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn> => {
        const { scope, remaining, hasProject, hasGlobal } = parseUiScopeFlags(
          args.trim(),
        );
        if (hasProject && hasGlobal) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'Cannot use both --project and --global. Choose one scope flag.',
            ),
          };
        }
        // Workspace settings are ignored on merge when untrusted, so a
        // --project save would silently not take effect — reject it up front.
        if (
          scope === SettingScope.Workspace &&
          context.services.settings &&
          !context.services.settings.isTrusted
        ) {
          return {
            type: 'message',
            messageType: 'error',
            content: t(
              'Workspace is untrusted; run /trust first or use --global.',
            ),
          };
        }
        const trimmedArgs = remaining;

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

        return setUiLanguage(context, targetLang, scope);
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
          supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
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
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,

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
